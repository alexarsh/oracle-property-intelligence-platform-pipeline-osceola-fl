#!/usr/bin/env node
/**
 * `osceola-pipeline` command-line interface.
 *
 * Stages can be run individually (`ingest appraiser`, `ingest gis`, …) or as a
 * whole run (`run --mode incremental`) which records run history and publishes.
 * Every command is idempotent: re-running with the same inputs is safe.
 *
 * @module cli
 */
import { Command } from "commander";
import { DUCKDB_PATH, DEFAULT_TAX_YEAR, newRunId } from "./config.js";
import { Db } from "./duckdb/client.js";
import { ensureLedger } from "./duckdb/ledger.js";
import { logger } from "./logger.js";
import { loadAppraiser } from "./sources/appraiser/index.js";
import { loadGisParcels } from "./sources/gis/index.js";
import { loadAccelaHarvests, loadBbbHarvests } from "./duckdb/load-harvests.js";
import { buildQueryTables, exportQueryTables } from "./transform/index.js";
import path from "node:path";
import { ARTIFACTS_DIR, VERIFY_GATEWAYS } from "./config.js";
import { publishRun } from "./publish/manifest.js";
import { verifyManifest } from "./publish/verify.js";
import { lastPublishedRun, readHistory, runDir } from "./runs/history.js";
import { readJson, writeJson } from "./util/fs.js";
import { RunManifest } from "@osceola/shared";

const program = new Command()
  .name("osceola-pipeline")
  .description("Oracle Property Intelligence pipeline — Osceola County, FL")
  .option("--db <path>", "DuckDB database path", DUCKDB_PATH)
  .option("--run-id <id>", "Run id to attribute loads to (default: a new ad-hoc id)");

async function withDb<T>(fn: (db: Db, runId: string) => Promise<T>): Promise<T> {
  const opts = program.opts<{ db: string; runId?: string }>();
  const db = await Db.open(opts.db);
  try {
    await ensureLedger(db);
    return await fn(db, opts.runId ?? newRunId("incremental"));
  } finally {
    await db.close();
  }
}

const ingest = program.command("ingest").description("Ingest one source into the raw layer");

ingest
  .command("appraiser")
  .description("Download + load the OCPA certified roll export for a tax year")
  .option("--tax-year <year>", "Tax year", String(DEFAULT_TAX_YEAR))
  .option("--force-download", "Re-download the ZIP", false)
  .option("--force-reload", "Re-load tables even if already loaded", false)
  .action(async (o: { taxYear: string; forceDownload: boolean; forceReload: boolean }) => {
    const result = await withDb((db, runId) =>
      loadAppraiser(db, { taxYear: Number(o.taxYear), runId, forceDownload: o.forceDownload, forceReload: o.forceReload }),
    );
    logger.info(result, "appraiser ingest finished");
  });

ingest
  .command("gis")
  .description("Sweep county GIS parcel centroids")
  .option("--updated-since <date>", "Only parcels updated on/after YYYY-MM-DD")
  .option("--concurrency <n>", "Parallel page requests", "4")
  .action(async (o: { updatedSince?: string; concurrency: string }) => {
    const result = await withDb((db, runId) =>
      loadGisParcels(db, { runId, updatedSince: o.updatedSince, concurrency: Number(o.concurrency) }),
    );
    logger.info(result, "gis ingest finished");
  });

ingest
  .command("harvests")
  .description("Load Accela / BBB harvest JSONL directories from data/raw into the raw layer")
  .action(async () => {
    const result = await withDb(async (db, runId) => ({
      accela: await loadAccelaHarvests(db, runId),
      bbb: await loadBbbHarvests(db, runId),
    }));
    logger.info(result, "harvest load finished");
  });

program
  .command("build")
  .description("Rebuild the reconciled query tables and export Parquet + coverage into artifacts/runs/<runId>/")
  .option("--run-date <date>", "As-of date for age / duration calculations (YYYY-MM-DD)", new Date().toISOString().slice(0, 10))
  .option("--out <dir>", "Output directory (default artifacts/runs/<runId>)")
  .action(async (o: { runDate: string; out?: string }) => {
    const result = await withDb(async (db, runId) => {
      const built = await buildQueryTables(db, runId, o.runDate);
      const outDir = o.out ?? path.join(ARTIFACTS_DIR, "runs", runId);
      const exported = await exportQueryTables(db, outDir, runId);
      return { runId, outDir, ...built, exported };
    });
    logger.info(result, "build finished");
  });

program
  .command("publish")
  .description("Pack a built run directory into a CAR, compute CIDs, write manifest.json; with --live upload to Filebase and re-point IPNS")
  .requiredOption("--run <runId>", "Run id whose artifacts/runs/<runId> directory to publish")
  .option("--live", "Upload to Filebase (requires credentials in the environment)", false)
  .action(async (o: { run: string; live: boolean }) => {
    const dir = runDir(o.run);
    const coverage = await readJson<{ tables: { table: string; rows: number }[] }>(path.join(dir, "coverage.json"));
    const rowCounts = Object.fromEntries(coverage.tables.map((t) => [t.table, t.rows]));
    const prev = await lastPublishedRun();
    const out = await publishRun({ runId: o.run, runDir: dir, previousRootCid: prev?.rootCid ?? null, rowCounts, live: o.live });
    logger.info({ root: out.manifest.root.cid, car: out.manifest.car, ipns: out.manifest.ipns, uploaded: out.uploaded, manifest: out.manifestPath }, "publish finished");
  });

program
  .command("verify")
  .description("Fetch every artifact CID from independent public gateways and compare bytes with the manifest")
  .requiredOption("--run <runId>", "Run id to verify")
  .option("--gateways <list>", "Comma-separated gateway base URLs", VERIFY_GATEWAYS.join(","))
  .option("--only <names>", "Comma-separated artifact names to verify (default all)")
  .option("--timeout <ms>", "Per-request timeout in ms", "180000")
  .action(async (o: { run: string; gateways: string; only?: string; timeout: string }) => {
    const dir = runDir(o.run);
    const manifest = RunManifest.parse(await readJson(path.join(dir, "manifest.json")));
    const report = await verifyManifest(manifest, {
      gateways: o.gateways.split(",").map((g) => g.trim()),
      timeoutMs: Number(o.timeout),
      ...(o.only ? { only: o.only.split(",").map((n) => n.trim()) } : {}),
    });
    await writeJson(path.join(dir, "verification.json"), report);
    logger.info({ allMatched: report.allMatched, artifacts: report.artifacts.length, gateways: report.gateways }, "verification finished");
    if (!report.allMatched) process.exitCode = 2;
  });

program
  .command("history")
  .description("Print the run history")
  .action(async () => {
    const h = await readHistory();
    for (const r of h.runs) {
      logger.info({ runId: r.runId, mode: r.mode, status: r.status, rootCid: r.rootCid, tableCounts: r.tableCounts, tableDeltas: r.tableDeltas }, "run");
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  logger.error({ err }, "command failed");
  process.exitCode = 1;
});
