/**
 * Loaders for the committed pipeline artifacts.
 *
 * The explorer reads `artifacts/run-history.json` and each run directory's
 * `manifest.json`, `coverage.json` and `verification.json` with `fs` at request
 * time. The directory is discovered by walking up from `process.cwd()` (works
 * from `apps/explorer` in dev and from the traced serverless bundle on Vercel)
 * or taken from `OSCEOLA_ARTIFACTS_DIR`.
 *
 * Nothing here talks to the MCP or to Parquet: these files are the pipeline's
 * own committed statement of what was ingested and published.
 *
 * @module artifacts
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { OSCEOLA, RunHistory, RunManifest } from "@osceola/shared";
import type { RunRecord, SourceRunResult, TableCounts } from "@osceola/shared";
import { z } from "zod";

export const CoverageReportSchema = z
  .object({
    county: z.string(),
    countyName: z.string().optional(),
    countyFips: z.string().optional(),
    runId: z.string(),
    exportedAt: z.string(),
    datasets: z.array(
      z
        .object({
          county: z.string().nullable().optional(),
          source: z.string(),
          ingested_count: z.number().nullable(),
          expected_count: z.number().nullable().optional(),
          first_loaded_at: z.string().nullable().optional(),
          last_loaded_at: z.string().nullable().optional(),
          cid: z.string().nullable().optional(),
          ipns_label: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
    tables: z.array(
      z.object({
        table: z.string(),
        rows: z.number(),
        columns: z.array(z.object({ column: z.string(), nonNull: z.number(), pct: z.number() })),
      }),
    ),
    sourceLoads: z
      .array(
        z
          .object({
            run_id: z.string().nullable().optional(),
            source: z.string(),
            item: z.string().nullable().optional(),
            url: z.string().nullable().optional(),
            digest: z.string().nullable().optional(),
            bytes: z.number().nullable().optional(),
            rows: z.number().nullable().optional(),
            fetched_at: z.string().nullable().optional(),
            notes: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type CoverageReport = z.infer<typeof CoverageReportSchema>;

const FetchCheckSchema = z.object({
  gateway: z.string(),
  url: z.string(),
  ok: z.boolean(),
  status: z.number().nullable(),
  bytes: z.number().nullable(),
  sha256: z.string().nullable(),
  matched: z.boolean(),
  ms: z.number(),
  error: z.string().nullable(),
});
export type FetchCheck = z.infer<typeof FetchCheckSchema>;

export const VerificationReportSchema = z
  .object({
    runId: z.string(),
    verifiedAt: z.string(),
    gateways: z.array(z.string()),
    artifacts: z.array(
      z.object({
        name: z.string(),
        cid: z.string(),
        expectedSize: z.number(),
        expectedDigest: z.string(),
        checks: z.array(FetchCheckSchema),
      }),
    ),
    rootPathCheck: z.array(FetchCheckSchema).default([]),
    allMatched: z.boolean(),
  })
  .passthrough();
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

/** Everything the UI knows about one run. */
export interface RunBundle {
  runId: string;
  /** From run-history.json, or derived from the manifest when history is absent. */
  record: RunRecord;
  /** True when `record` was synthesized because run-history.json has no entry yet. */
  derived: boolean;
  manifest: RunManifest | null;
  coverage: CoverageReport | null;
  verification: VerificationReport | null;
}

export interface ArtifactsSnapshot {
  artifactsDir: string | null;
  history: RunHistory | null;
  /** Newest first. */
  runs: RunBundle[];
  latest: RunBundle | null;
  /** Human-readable problems (missing files, parse errors) surfaced in the UI. */
  warnings: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Locate the artifacts directory: env override, then walk up from cwd. */
export async function findArtifactsDir(start = process.cwd()): Promise<string | null> {
  const fromEnv = process.env.OSCEOLA_ARTIFACTS_DIR?.trim();
  if (fromEnv && (await exists(fromEnv))) return fromEnv;
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "artifacts");
    if (
      (await exists(path.join(candidate, "runs"))) ||
      (await exists(path.join(candidate, "run-history.json")))
    )
      return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function readJsonIf<T>(
  file: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  warnings: string[],
): Promise<T | null> {
  if (!(await exists(file))) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(await fs.readFile(file, "utf8")));
    if (!parsed.success) {
      warnings.push(
        `${path.basename(path.dirname(file))}/${path.basename(file)}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      );
      return null;
    }
    return parsed.data;
  } catch (err) {
    warnings.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Build a RunRecord from a manifest + coverage when run-history.json has no entry yet. */
export function deriveRecord(
  runId: string,
  manifest: RunManifest | null,
  coverage: CoverageReport | null,
  verification: VerificationReport | null,
): RunRecord {
  const tableCounts: TableCounts = {};
  for (const a of manifest?.artifacts ?? []) {
    if (a.rowCount != null && a.name.startsWith("query-tables/"))
      tableCounts[a.name.replace("query-tables/", "").replace(/\.parquet$/, "")] = a.rowCount;
  }
  for (const t of coverage?.tables ?? []) tableCounts[t.table] ??= t.rows;
  const loadsBySource = new Map<
    string,
    { rows: number; fetchedAt: string | null; urls: Set<string> }
  >();
  for (const l of coverage?.sourceLoads ?? []) {
    const e = loadsBySource.get(l.source) ?? { rows: 0, fetchedAt: null, urls: new Set<string>() };
    e.rows += l.rows ?? 0;
    if (l.fetched_at && (!e.fetchedAt || l.fetched_at > e.fetchedAt)) e.fetchedAt = l.fetched_at;
    if (l.url) e.urls.add(l.url);
    loadsBySource.set(l.source, e);
  }
  const sources: SourceRunResult[] = Object.values(OSCEOLA.sources).map((s) => {
    const load = loadsBySource.get(s.key);
    return {
      source: s.key,
      status: load ? "ok" : "skipped",
      fetchedAt: load?.fetchedAt ? toIso(load.fetchedAt) : null,
      window: null,
      recordsSeen: load?.rows ?? 0,
      recordsNew: load?.rows ?? 0,
      recordsChanged: 0,
      recordsQuarantined: 0,
      durationMs: 0,
      requestCount: null,
      urls: load ? [...load.urls] : [s.url],
      limitations: [...s.limitations],
      error: null,
    };
  });
  const startedAt =
    runIdToIso(runId) ?? manifest?.publishedAt ?? coverage?.exportedAt ?? new Date(0).toISOString();
  return {
    runId,
    county: OSCEOLA.key,
    mode: runId.endsWith("-full") ? "full" : "incremental",
    startedAt,
    finishedAt: manifest?.publishedAt ?? null,
    status: manifest ? "succeeded" : "running",
    pipelineCommit: null,
    sources,
    tableCounts,
    tableDeltas: {},
    manifestCid: null,
    rootCid: manifest?.root.cid ?? null,
    previousRootCid: manifest?.previousRootCid ?? null,
    ipnsName: manifest?.ipns?.name ?? null,
    verification: verification
      ? {
          verifiedAt: verification.verifiedAt,
          gateways: verification.gateways,
          artifactsChecked: verification.artifacts.length,
          allMatched: verification.allMatched,
        }
      : null,
    notes: [
      "Run record derived from manifest.json/coverage.json: artifacts/run-history.json has no entry for this run yet.",
    ],
  };
}

/** `2026-09-07T00-00-00Z-full` → `2026-09-07T00:00:00Z`. */
export function runIdToIso(runId: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(runId);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : null;
}

/** DuckDB timestamps (`2026-09-07 08:51:42.781`) → ISO with Z. */
export function toIso(ts: string): string {
  if (/^\d{4}-\d{2}-\d{2} /.test(ts)) return `${ts.replace(" ", "T")}Z`;
  return ts;
}

/** Load history + every run directory. Never throws; problems land in `warnings`. */
export async function loadArtifacts(start = process.cwd()): Promise<ArtifactsSnapshot> {
  const warnings: string[] = [];
  const artifactsDir = await findArtifactsDir(start);
  if (!artifactsDir) {
    return {
      artifactsDir: null,
      history: null,
      runs: [],
      latest: null,
      warnings: [
        "artifacts directory not found (set OSCEOLA_ARTIFACTS_DIR or run the pipeline first)",
      ],
    };
  }
  const history = await readJsonIf(
    path.join(artifactsDir, "run-history.json"),
    RunHistory,
    warnings,
  );
  if (!history)
    warnings.push(
      "artifacts/run-history.json is missing; run records below are derived from each run's manifest.json.",
    );

  const runsDir = path.join(artifactsDir, "runs");
  const runIds = new Set<string>();
  if (await exists(runsDir)) {
    for (const entry of await fs.readdir(runsDir, { withFileTypes: true }))
      if (entry.isDirectory()) runIds.add(entry.name);
  }
  for (const r of history?.runs ?? []) runIds.add(r.runId);

  const runs: RunBundle[] = [];
  for (const runId of runIds) {
    const dir = path.join(runsDir, runId);
    const manifest = await readJsonIf(dir + "/manifest.json", RunManifest, warnings);
    const coverage = await readJsonIf(dir + "/coverage.json", CoverageReportSchema, warnings);
    const verification = await readJsonIf(
      dir + "/verification.json",
      VerificationReportSchema,
      warnings,
    );
    const record = history?.runs.find((r) => r.runId === runId) ?? null;
    runs.push({
      runId,
      record: record ?? deriveRecord(runId, manifest, coverage, verification),
      derived: record === null,
      manifest,
      coverage,
      verification,
    });
  }
  runs.sort(
    (a, b) =>
      b.record.startedAt.localeCompare(a.record.startedAt) || b.runId.localeCompare(a.runId),
  );
  return { artifactsDir, history, runs, latest: runs[0] ?? null, warnings };
}

/** Single run by id (or the latest when `runId` is omitted). */
export async function loadRun(
  runId?: string,
): Promise<{ run: RunBundle | null; snapshot: ArtifactsSnapshot }> {
  const snapshot = await loadArtifacts();
  const run = runId ? (snapshot.runs.find((r) => r.runId === runId) ?? null) : snapshot.latest;
  return { run, snapshot };
}
