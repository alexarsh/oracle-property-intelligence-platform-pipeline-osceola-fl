/**
 * Artifact manifest and run-history contracts.
 *
 * The manifest is the machine-readable statement of *what was published* for a
 * pipeline run. CIDs are the durable identity of every artifact; gateway URLs are
 * derived conveniences and are never stored as the source of truth.
 *
 * @module manifest
 */
import { z } from "zod";

/** CIDv1 base32 (`bafy…` / `bafk…`). */
export const cidV1 = z.string().regex(/^baf[a-z2-7]{50,}$/, "expected a CIDv1 base32 string");

export const ManifestArtifact = z.object({
  /** Logical path inside the run directory, e.g. `query-tables/properties.parquet`. */
  name: z.string(),
  cid: cidV1,
  size: z.number().int().nonnegative(),
  /** UnixFS node kind. */
  codec: z.enum(["file", "directory"]),
  /** `sha256:<hex>` of the raw bytes (files) or of the CAR (directories). */
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  mediaType: z.string().nullable(),
  /** Table row count for query tables, null otherwise. */
  rowCount: z.number().int().nonnegative().nullable(),
  /** Optional provider multiaddrs while a candidate-operated node still serves the blocks. */
  origins: z.array(z.string()).default([]),
});
export type ManifestArtifact = z.infer<typeof ManifestArtifact>;

export const RunManifest = z.object({
  schemaVersion: z.literal("1.0"),
  county: z.string(),
  countyFips: z.string(),
  runId: z.string(),
  /** ISO timestamp the manifest was sealed. */
  publishedAt: z.string().datetime(),
  /** Directory root of the whole run (every artifact is `<root>/<name>`). */
  root: ManifestArtifact,
  /** CAR file carrying the DAG rooted at `root.cid`, so any node can import it. */
  car: z.object({
    fileName: z.string(),
    size: z.number().int(),
    digest: z.string(),
    cid: cidV1.nullable(),
  }),
  artifacts: z.array(ManifestArtifact),
  ipns: z
    .object({
      name: z.string(),
      label: z.string(),
      resolvedCid: cidV1,
      publishedAt: z.string().datetime(),
    })
    .nullable(),
  /** The previous run's root CID (immutable; never rewritten). */
  previousRootCid: cidV1.nullable(),
  /** Public gateways used for the independent-retrieval proof. */
  gateways: z.array(z.string().url()),
});
export type RunManifest = z.infer<typeof RunManifest>;

export const SourceRunResult = z.object({
  source: z.string(),
  status: z.enum(["ok", "partial", "skipped", "failed", "blocked"]),
  fetchedAt: z.string().datetime().nullable(),
  /** e.g. `{since, until}` for windowed sources or `{taxYear}` for bulk. */
  window: z.record(z.string()).nullable(),
  recordsSeen: z.number().int().nonnegative(),
  recordsNew: z.number().int().nonnegative(),
  recordsChanged: z.number().int().nonnegative(),
  recordsQuarantined: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  requestCount: z.number().int().nonnegative().nullable(),
  /** Canonical URL(s) read; kept short (the raw archive holds the rest). */
  urls: z.array(z.string()),
  limitations: z.array(z.string()),
  error: z.string().nullable(),
});
export type SourceRunResult = z.infer<typeof SourceRunResult>;

export const TableCounts = z.record(z.number().int().nonnegative());
export type TableCounts = z.infer<typeof TableCounts>;

export const RunRecord = z.object({
  runId: z.string(),
  county: z.string(),
  mode: z.enum(["full", "incremental"]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  status: z.enum(["running", "succeeded", "failed"]),
  /** Git commit of the pipeline code that produced the run. */
  pipelineCommit: z.string().nullable(),
  sources: z.array(SourceRunResult),
  /** Row counts of every published query table after this run. */
  tableCounts: TableCounts,
  /** Row-count deltas versus the previous successful run. */
  tableDeltas: TableCounts,
  manifestCid: cidV1.nullable(),
  rootCid: cidV1.nullable(),
  previousRootCid: cidV1.nullable(),
  ipnsName: z.string().nullable(),
  /** Independent gateway verification outcome. */
  verification: z
    .object({
      verifiedAt: z.string().datetime(),
      gateways: z.array(z.string()),
      artifactsChecked: z.number().int(),
      allMatched: z.boolean(),
    })
    .nullable(),
  notes: z.array(z.string()),
});
export type RunRecord = z.infer<typeof RunRecord>;

export const RunHistory = z.object({
  schemaVersion: z.literal("1.0"),
  county: z.string(),
  runs: z.array(RunRecord),
});
export type RunHistory = z.infer<typeof RunHistory>;
