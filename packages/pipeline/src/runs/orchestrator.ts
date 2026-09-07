/**
 * Run orchestrator: one `full` or `incremental` pipeline run, end to end.
 *
 *   appraiser (bulk, idempotent by digest)
 *   -> GIS centroids (full sweep, or `LastUpdate` window)
 *   -> Accela roofing permits (date window since the last run, with overlap)
 *   -> load harvests -> build query tables -> export Parquet + coverage
 *   -> pack CAR + manifest (+ upload + IPNS when credentials exist)
 *   -> verify from independent gateways (when published)
 *   -> append run history
 *
 * Every stage is idempotent; the run record is written as `running` first and
 * updated at the end, so an interrupted run is visible in history rather than
 * silently missing. Stage failures in enrichment sources (Accela, BBB) are
 * recorded as `failed` source results and do not abort the run — the roll and
 * GIS are required, enrichment is best-effort and reported honestly.
 *
 * @module runs/orchestrator
 */
import path from "node:path";
import type { RunRecord, SourceRunResult } from "@osceola/shared";
import {
  COUNTY,
  DATA_DIR,
  DEFAULT_TAX_YEAR,
  VERIFY_GATEWAYS,
  hasFilebaseCredentials,
} from "../config.js";
import type { Db } from "../duckdb/client.js";
import { loadAccelaHarvests, loadBbbHarvests } from "../duckdb/load-harvests.js";
import { logger } from "../logger.js";
import { publishRun } from "../publish/manifest.js";
import { verifyManifest } from "../publish/verify.js";
import { loadAppraiser } from "../sources/appraiser/index.js";
import { loadGisParcels } from "../sources/gis/index.js";
import { buildQueryTables, exportQueryTables } from "../transform/index.js";
import { writeJson } from "../util/fs.js";
import {
  lastPublishedRun,
  pipelineCommit,
  previousSuccessfulRun,
  runDir,
  tableDeltas,
  upsertRun,
} from "./history.js";

export interface RunOptions {
  runId: string;
  mode: "full" | "incremental";
  /** As-of date for age/duration math and the end of the permit window (YYYY-MM-DD). */
  runDate: string;
  /** Permit window start; default = last successful run date minus `overlapDays`, or 90 days back on a first run. */
  permitsSince?: string | undefined;
  /** Days of overlap re-harvested so late status changes are caught. */
  overlapDays?: number;
  /** Skip the Accela harvest (e.g. offline). */
  skipPermits?: boolean;
  /** Skip the GIS sweep. */
  skipGis?: boolean;
  /** Upload to Filebase when credentials exist (default: yes when present). */
  publish?: boolean;
  /** Run the two-gateway verification after publishing. */
  verify?: boolean;
  /** Artifacts to verify; default all files. */
  verifyOnly?: string[];
}

function daysAgo(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function failedSource(source: string, err: unknown, startedMs: number): SourceRunResult {
  return {
    source,
    status: "failed",
    fetchedAt: null,
    window: null,
    recordsSeen: 0,
    recordsNew: 0,
    recordsChanged: 0,
    recordsQuarantined: 0,
    durationMs: Date.now() - startedMs,
    requestCount: null,
    urls: [],
    limitations: [],
    error: err instanceof Error ? err.message : String(err),
  };
}

/** Harvest the Accela window via the vendor module (loaded lazily so the pipeline runs without it). */
async function harvestAccela(
  runId: string,
  since: string,
  until: string,
): Promise<SourceRunResult> {
  const t0 = Date.now();
  const source = COUNTY.sources.osceola_accela!;
  const mod = (await import("../sources/accela/index.js")) as {
    harvestRange: (o: {
      since: string;
      until: string;
      outDir: string;
      concurrency?: number;
    }) => Promise<
      Array<{
        searchHits: number;
        detailsFetched: number;
        detailsFailed: number;
        requestCount: number;
        capped: boolean;
      }>
    >;
  };
  const outDir = path.join(DATA_DIR, "raw", "accela", `${runId}_${since}_${until}`);
  const summaries = await mod.harvestRange({ since, until, outDir, concurrency: 2 });
  const sum = (k: "searchHits" | "detailsFetched" | "detailsFailed" | "requestCount") =>
    summaries.reduce((a, s) => a + s[k], 0);
  return {
    source: source.key,
    status: sum("detailsFailed") > 0 ? "partial" : "ok",
    fetchedAt: new Date().toISOString(),
    window: { since, until, windows: String(summaries.length) },
    recordsSeen: sum("searchHits"),
    recordsNew: 0, // filled after load
    recordsChanged: 0,
    recordsQuarantined: sum("detailsFailed"),
    durationMs: Date.now() - t0,
    requestCount: sum("requestCount"),
    urls: [source.url],
    limitations: [...source.limitations],
    error: null,
  };
}

/** Execute a run. Returns the final run record (also persisted to run history). */
export async function executeRun(db: Db, opts: RunOptions): Promise<RunRecord> {
  const log = logger.child({ stage: "run", runId: opts.runId, mode: opts.mode });
  const startedAt = new Date().toISOString();
  const prev = await previousSuccessfulRun(opts.runId);
  const lastPublished = await lastPublishedRun();
  const record: RunRecord = {
    runId: opts.runId,
    county: COUNTY.key,
    mode: opts.mode,
    startedAt,
    finishedAt: null,
    status: "running",
    pipelineCommit: await pipelineCommit(),
    sources: [],
    tableCounts: {},
    tableDeltas: {},
    manifestCid: null,
    rootCid: null,
    previousRootCid: lastPublished?.rootCid ?? null,
    ipnsName: null,
    verification: null,
    notes: [],
  };
  await upsertRun(record);

  try {
    // 1. Appraiser roll (bulk; skipped automatically when the digest is unchanged).
    record.sources.push(await loadAppraiser(db, { taxYear: DEFAULT_TAX_YEAR, runId: opts.runId }));

    // 2. GIS centroids.
    if (!opts.skipGis) {
      const t0 = Date.now();
      try {
        const updatedSince =
          opts.mode === "incremental" && prev ? prev.startedAt.slice(0, 10) : undefined;
        record.sources.push(
          await loadGisParcels(db, { runId: opts.runId, updatedSince, concurrency: 4 }),
        );
      } catch (err) {
        log.error({ err }, "gis sweep failed");
        record.sources.push(failedSource("osceola_gis_parcels", err, t0));
      }
    }

    // 3. Accela roofing permits (windowed; overlap catches late status changes).
    if (!opts.skipPermits) {
      const t0 = Date.now();
      const overlap = opts.overlapDays ?? 14;
      const since =
        opts.permitsSince ??
        (prev ? daysAgo(prev.startedAt.slice(0, 10), overlap) : daysAgo(opts.runDate, 90));
      try {
        const res = await harvestAccela(opts.runId, since, opts.runDate);
        const loaded = await loadAccelaHarvests(db, opts.runId);
        res.recordsNew = loaded.inserted;
        res.recordsChanged = loaded.changed;
        record.sources.push(res);
      } catch (err) {
        log.error({ err }, "accela harvest failed");
        record.sources.push({
          ...failedSource("osceola_accela", err, t0),
          window: { since, until: opts.runDate },
        });
      }
    }

    // 4. BBB profiles harvested out-of-band (US egress) are picked up whenever present.
    const bbb = await loadBbbHarvests(db, opts.runId);
    if (bbb.files > 0)
      record.notes.push(`BBB profiles loaded: ${bbb.seen} rows from ${bbb.files} harvest file(s)`);

    // 5. Build + export.
    const built = await buildQueryTables(db, opts.runId, opts.runDate);
    const outDir = runDir(opts.runId);
    await exportQueryTables(db, outDir, opts.runId);
    record.tableCounts = built.counts;
    record.tableDeltas = tableDeltas(built.counts, prev?.tableCounts ?? null);
    if (built.bbbMatched > 0)
      record.notes.push(`Contractors matched to BBB profiles: ${built.bbbMatched}`);

    // 6. Publish (pack always; upload when allowed and possible).
    const live = (opts.publish ?? true) && hasFilebaseCredentials();
    if (!live)
      record.notes.push(
        "Publish ran in pack-only mode (no Filebase credentials in the environment); CIDs are computed locally and identical to what a live publish pins.",
      );
    const pub = await publishRun({
      runId: opts.runId,
      runDir: outDir,
      previousRootCid: record.previousRootCid,
      rowCounts: built.counts,
      live,
    });
    record.rootCid = pub.manifest.root.cid;
    record.ipnsName = pub.manifest.ipns?.name ?? null;
    if (pub.uploaded) {
      const { uploadFile } = await import("../publish/filebase.js");
      const m = await uploadFile(
        pub.manifestPath,
        `runs/${opts.runId}/manifest.json`,
        "application/json",
      );
      record.manifestCid = m.cid;
    }

    // 7. Independent verification.
    if (pub.uploaded && (opts.verify ?? true)) {
      const report = await verifyManifest(pub.manifest, {
        gateways: VERIFY_GATEWAYS,
        ...(opts.verifyOnly ? { only: opts.verifyOnly } : {}),
      });
      await writeJson(path.join(outDir, "verification.json"), report);
      record.verification = {
        verifiedAt: report.verifiedAt,
        gateways: report.gateways,
        artifactsChecked: report.artifacts.length,
        allMatched: report.allMatched,
      };
    }

    record.status = "succeeded";
  } catch (err) {
    record.status = "failed";
    record.notes.push(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    log.error({ err }, "run failed");
  } finally {
    record.finishedAt = new Date().toISOString();
    await upsertRun(record);
    await writeJson(path.join(runDir(opts.runId), "run-summary.json"), record);
  }
  return record;
}
