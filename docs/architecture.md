# Architecture

## Goal

Load every available public dataset for **Osceola County, FL** that supports
roofing-lead discovery, keep it fresh incrementally, and make it queryable by a
UI, by agents and by the roofing CRM — **without Oracle paying for any
always-on infrastructure**.

## The shape of the system

```
public sources ──► pipeline (TypeScript CLI, DuckDB in-process) ──► Parquet query tables
                                                                        │
                       GitHub Actions cron (free)  ◄── run history ◄────┤ CAR + manifest (CIDv1)
                                                                        ▼
                                                  IPFS (Filebase pin + IPNS pointer; public gateways)
                                                                        │
                    ┌───────────────────────────────────────────────────┼─────────────────────┐
                    ▼                                                   ▼                     ▼
      Elephant MCP (@elephant-xyz/mcp, Vercel)              Explorer UI (Next.js, Vercel)   Roofing CRM (Next.js, Vercel)
      DuckDB httpfs range-reads the Parquet by CID          run summary · manifest · SQL     map · radius · leads · agent
                    ▲                                        console · leads · agent ─────────┘ (both talk MCP only)
                    └── any agent / Cursor / Claude Desktop (mcp.json)
```

There is no database server, no queue, no VM. Compute happens inside a
pipeline run (laptop or a GitHub Actions runner); storage is content-addressed
and pinned on Filebase's free tier; serving is stateless functions on Vercel's
free tier that read the public Parquet. If every one of those accounts vanished,
the CIDs in `artifacts/run-history.json` would still name the data and anyone
holding the CAR could re-seed it.

## Layers inside the pipeline

| Layer      | What lives there                                                                                                                                                                                        | Where                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Raw        | Lossless copies of each source as DuckDB tables (`raw_ocpa_*`, `raw_gis_parcels`, `raw_accela_permits`, `raw_bbb_profiles`) plus `source_loads` (URL, digest, bytes, rows, fetched-at per file per run) | `packages/pipeline/src/sources/*`, `duckdb/` |
| Reconciled | `properties_base` → `permits_stage` → `contractors` (license > phone > name identity cascade) → `permits` → `properties`                                                                                | `packages/pipeline/src/transform/*`          |
| Published  | `properties.parquet`, `permits.parquet`, `contractors.parquet`, `coverage.json`, `samples/*.csv` — packed into one UnixFS directory + CAR                                                               | `packages/pipeline/src/publish/*`            |
| History    | `artifacts/run-history.json` (append-only), `artifacts/runs/<runId>/{manifest,coverage,verification,run-summary}.json`                                                                                  | `packages/pipeline/src/runs/*`               |

Contracts for all of the above are typed once in `@osceola/shared` (zod +
TypeScript) and consumed by the pipeline, the Explorer and the CRM.

## Why the query tables use the kit's schema

`properties` keeps the exact column set of the soofi-xyz kit's county query
table and appends roofing columns. That is what lets the **stock Elephant MCP**
serve Osceola with zero code: `PROPERTY_QUERY_TABLE_MAP={"osceola": <gateway url of the parquet>}`.
The `donphan` agent's playbook (schema first, single read-only SELECT, cap rows,
report methodology) works unchanged, and the CRM does not need a private API.
Extra columns (`roof_age_years`, `open_roof_permit_count`, `owner_out_of_state`,
`contractor_license`, `bbb_rating`, `days_open`, …) are additive, so nothing in
the kit breaks and everything roofing-specific is one SQL predicate away.

## Continuous / incremental ingestion

| Source                              | Cadence    | Incremental strategy                                                                                                                                                                                 |
| ----------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appraiser certified roll (bulk ZIP) | annual     | Idempotent by SHA-256 of the ZIP; a new certification loads as a new tax year.                                                                                                                       |
| County GIS parcels (ArcGIS)         | weekly     | `LastUpdate >= <previous run date>`; upsert by parcel number; resumable paged sweep with checkpoint.                                                                                                 |
| County Accela permits (portal)      | continuous | Date window `[previous run − 14 days overlap, run date]`, record type _Roofing Permit_; windows that hit the portal's 100-hit cap are bisected; content hash per detail page detects status changes. |
| BBB roofing contractors             | weekly     | Category re-crawl from US egress; upsert by BBB id.                                                                                                                                                  |

Every published row carries `first_seen_run_id`, `last_changed_run_id` and a
`row_hash` of its business columns, so **deltas are visible per row, not just as
counts**. Each run appends a `RunRecord` with per-source `seen / new / changed /
quarantined`, table counts and deltas, the new root CID and the previous root CID.

The scheduled loop is `.github/workflows/incremental-refresh.yml`: weekly and on
demand, it runs the pipeline, publishes a **new** snapshot (new CID; previous CIDs
untouched), verifies retrieval from two independent gateways, and commits the
manifest + history back to the branch — which redeploys the Explorer.

## Publication and identity

- The run directory is encoded as a UnixFS DAG (CIDv1, sha2-256, raw leaves,
  256 KiB chunks) **locally**; every file and directory gets its CID before any
  network call. `ipfs-car ls` on the produced CAR reproduces the same CIDs.
- The CAR is uploaded to Filebase with `import: car`, so Filebase pins exactly our
  DAG; the pipeline asserts that the CID Filebase reports equals the local root
  and refuses to write a manifest otherwise.
- `manifest.json` (per run, committed) lists every artifact with `cid`, `name`,
  `size`, `codec`, `digest` (`sha256:` of the raw bytes), `mediaType`, `rowCount`,
  plus the CAR's size/digest, the IPNS name **and** the resolved CID.
- `verification.json` records fetches of each artifact CID from `ipfs.io` and
  `dweb.link` (gateways this project does not operate) with byte counts and
  digests compared to the manifest.
- IPNS (`oracle-osceola-runs`) is a pointer to the latest root; consumers who
  need a fixed snapshot use the run's root CID.

## Cost model (what Oracle pays by default)

| Component            | Service                      | Standing cost |
| -------------------- | ---------------------------- | ------------- |
| Pipeline compute     | GitHub Actions (public repo) | $0            |
| Storage / pinning    | Filebase free tier (5 GB)    | $0            |
| MCP + Explorer + CRM | Vercel Hobby                 | $0            |
| CRM leads database   | Neon free tier               | $0            |
| Data identity        | IPFS CIDs                    | $0 forever    |

Scaling past the free tiers is a budget decision, not an architecture change.

## Kit conformance and deliberate deviations

- **Used from the kit:** the query-table schema, the stock `@elephant-xyz/mcp`
  server and its deployment pattern (`deploy-open-data-mcp`), the `donphan`
  agent playbook for the LLM agents, the `bbb-harvest` matching cascade,
  `county-permit-adapter` guidance for the Accela module, Vercel AI SDK for every
  LLM call, TypeScript everywhere, Vitest + ESLint + Prettier.
- **Deviated:** no Restate/Postgres/Neon ingestion stack and no AWS CDK. The
  assignment's cost rule and the absence of an AWS account made a DuckDB-only,
  serverless-free pipeline the honest choice; the durable-workflow concerns
  (idempotency, checkpoints, resumability, run manifests) are implemented
  directly in the CLI and documented per stage.
