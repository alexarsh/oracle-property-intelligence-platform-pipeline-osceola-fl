/**
 * Transform orchestration: raw layer -> reconciled query tables -> Parquet.
 *
 * Order matters (each step reads the previous one's output):
 *   properties_base -> permits_stage -> contractors -> permits -> properties
 *
 * `exportQueryTables` then writes one Parquet per table plus `coverage.json`
 * (the kit's dataset-coverage snapshot shape, extended with per-column
 * non-null coverage) and small CSV sample extracts for human inspection.
 *
 * @module transform
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { QUERY_TABLES, type QueryTableName } from "@osceola/shared";
import { COUNTY } from "../config.js";
import type { Db } from "../duckdb/client.js";
import { lit } from "../duckdb/client.js";
import { logger } from "../logger.js";
import { writeJson } from "../util/fs.js";
import { buildContractors } from "./contractors.js";
import { buildPermits, buildPermitsStage } from "./permits.js";
import { buildProperties, buildPropertiesBase } from "./properties.js";

export interface BuildResult {
  counts: Record<QueryTableName, number>;
  bbbMatched: number;
}

/** Rebuild every query table inside DuckDB. Idempotent; lineage columns carry forward. */
export async function buildQueryTables(
  db: Db,
  runId: string,
  runDate: string,
): Promise<BuildResult> {
  const log = logger.child({ stage: "transform", runId });
  const t0 = Date.now();
  const base = await buildPropertiesBase(db);
  log.info({ rows: base, ms: Date.now() - t0 }, "properties_base built");
  const staged = await buildPermitsStage(db, runDate);
  log.info({ rows: staged, ms: Date.now() - t0 }, "permits_stage built");
  const c = await buildContractors(db);
  log.info({ ...c, ms: Date.now() - t0 }, "contractors built");
  const permits = await buildPermits(db, runId);
  log.info({ rows: permits, ms: Date.now() - t0 }, "permits built");
  const properties = await buildProperties(db, runId, runDate);
  log.info({ rows: properties, ms: Date.now() - t0 }, "properties built");
  return { counts: { properties, permits, contractors: c.contractors }, bbbMatched: c.bbbMatched };
}

export interface ColumnCoverage {
  column: string;
  nonNull: number;
  pct: number;
}

/** Non-null coverage per column for one table (drives the honest coverage report). */
export async function columnCoverage(db: Db, table: QueryTableName): Promise<ColumnCoverage[]> {
  const cols = QUERY_TABLES[table].map((c) => c.name);
  const total = await db.count(table);
  const exprs = cols.map((c) => `count(${c}) AS "${c}"`).join(", ");
  const row =
    (await db.one<Record<string, bigint | number>>(`SELECT ${exprs} FROM ${table}`)) ?? {};
  return cols.map((c) => {
    const nonNull = Number(row[c] ?? 0);
    return { column: c, nonNull, pct: total ? Math.round((nonNull / total) * 1000) / 10 : 0 };
  });
}

export interface ExportedTable {
  table: QueryTableName;
  file: string;
  rows: number;
}

/**
 * Write Parquet query tables + coverage + samples into `outDir`.
 * Column order follows `@osceola/shared` so the schema is stable across runs.
 */
export async function exportQueryTables(
  db: Db,
  outDir: string,
  runId: string,
): Promise<ExportedTable[]> {
  const tablesDir = path.join(outDir, "query-tables");
  const samplesDir = path.join(outDir, "samples");
  await mkdir(tablesDir, { recursive: true });
  await mkdir(samplesDir, { recursive: true });
  const exported: ExportedTable[] = [];
  const coverage: Record<string, unknown>[] = [];
  const perSource: Record<string, unknown>[] = [];

  for (const table of Object.keys(QUERY_TABLES) as QueryTableName[]) {
    const cols = QUERY_TABLES[table].map((c) => `${c.name}::${c.type} AS ${c.name}`).join(", ");
    const file = path.join(tablesDir, `${table}.parquet`);
    await db.run(
      `COPY (SELECT ${cols} FROM ${table} ORDER BY 1) TO ${lit(file)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 65536)`,
    );
    const rows = await db.count(table);
    exported.push({ table, file: path.relative(outDir, file), rows });
    coverage.push({ table, rows, columns: await columnCoverage(db, table) });
  }

  // Per-source counts in the kit's dataset-coverage shape.
  const sourceRows = await db.all<{
    source_system: string;
    n: bigint | number;
    first_loaded: string;
    last_loaded: string;
  }>(`
    SELECT source_system, count(*) AS n, min(fetched_at)::VARCHAR AS first_loaded, max(fetched_at)::VARCHAR AS last_loaded FROM permits GROUP BY 1
    UNION ALL
    SELECT 'osceola_appraiser (properties)', count(*), (SELECT min(fetched_at)::VARCHAR FROM source_loads WHERE source='ocpa_certified'), (SELECT max(fetched_at)::VARCHAR FROM source_loads WHERE source='ocpa_certified') FROM properties
    UNION ALL
    SELECT 'osceola_gis_parcels', count(*), min(fetched_at)::VARCHAR, max(fetched_at)::VARCHAR FROM raw_gis_parcels`);
  for (const r of sourceRows) {
    perSource.push({
      county: COUNTY.key,
      source: r.source_system,
      ingested_count: Number(r.n),
      expected_count: null,
      first_loaded_at: r.first_loaded,
      last_loaded_at: r.last_loaded,
      cid: null,
      ipns_label: null,
    });
  }
  const loads = await db.all(
    `SELECT run_id, source, item, url, digest, bytes, rows, fetched_at::VARCHAR AS fetched_at, notes FROM source_loads ORDER BY fetched_at`,
  );
  await writeJson(path.join(outDir, "coverage.json"), {
    county: COUNTY.key,
    countyName: COUNTY.name,
    countyFips: COUNTY.fips,
    runId,
    exportedAt: new Date().toISOString(),
    datasets: perSource,
    tables: coverage,
    sourceLoads: loads.map((l) => ({ ...l, bytes: Number(l.bytes), rows: Number(l.rows) })),
  });

  // Sample extracts: roofing leads and long-open roofing permits.
  await db.run(`COPY (
      SELECT request_identifier, address_street, address_city, address_zip, latitude, longitude, built_year, roof_age_basis,
             roof_age_years, open_roof_permit_count, oldest_open_roof_permit_days, owner_name, owner_mail_state, last_sale_date, source_urls
      FROM properties WHERE roof_age_years >= ${COUNTY.thresholds.roofAgeYears} AND latitude IS NOT NULL AND property_type = 'residential'
      ORDER BY roof_age_years DESC, request_identifier LIMIT 500)
    TO ${lit(path.join(samplesDir, "aged-roofs-sample.csv"))} (HEADER, DELIMITER ',')`);
  await db.run(`COPY (
      SELECT permit_number, parcel_identifier, source_system, issuing_agency, improvement_status, permit_issue_date, days_open,
             contractor_name, contractor_phone, contractor_license, bbb_rating, address_street, address_zip, latitude, longitude, source_url
      FROM permits WHERE is_roofing AND is_open ORDER BY days_open DESC NULLS LAST, permit_number LIMIT 500)
    TO ${lit(path.join(samplesDir, "long-open-roofing-permits-sample.csv"))} (HEADER, DELIMITER ',')`);
  return exported;
}
