/**
 * Overture Maps places — the business / point-of-interest layer.
 *
 * The kit's `overture-places-ingest` skill is followed as far as it applies to a
 * DuckDB-only pipeline:
 *
 * 1. The Overture release is resolved once and **pinned** in the run record
 *    (`OVERTURE_RELEASE`, default 2026-08-19.0); a rerun never drifts.
 * 2. Clipping uses the Census cartographic county polygon (GEOID 12097):
 *    a bounding-box predicate prunes Parquet row groups on S3, then
 *    `ST_Within` is the real county test. The bbox count is diagnostic only.
 * 3. Category logic keys on `taxonomy.hierarchy` (never the deprecated
 *    `categories.primary`, retained only as `legacy_category_primary`).
 * 4. Source-dataset gate: rows whose `sources` include OpenStreetMap are
 *    excluded (licence), and the excluded count is reported.
 * 5. `expected_count` is NULL — Overture is a numerator, not a denominator.
 *
 * DuckDB reads the public bucket anonymously (`s3://overturemaps-us-west-2`),
 * so this stage needs no credentials; the S3 scan is the slow part (~1–3 min).
 *
 * @module sources/overture
 */
import path from "node:path";
import { stat } from "node:fs/promises";
import type { SourceRunResult } from "@osceola/shared";
import { COUNTY, DATA_DIR } from "../../config.js";
import type { Db } from "../../duckdb/client.js";
import { lit } from "../../duckdb/client.js";
import { recordLoad } from "../../duckdb/ledger.js";
import { logger } from "../../logger.js";
import { downloadFile, exists, sha256File } from "../../util/fs.js";

export const OVERTURE_RELEASE = process.env.OVERTURE_RELEASE ?? "2026-08-19.0";
export const OVERTURE_PLACES_GLOB = (release: string): string =>
  `s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*`;
export const OVERTURE_SOURCE_URL = (release: string): string =>
  `https://stac.overturemaps.org/${release}/catalog.json`;

/** Census cartographic boundary file (1:500k), authoritative county polygons. */
export const CENSUS_COUNTY_ZIP_URL =
  "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip";

export function overturePaths(release: string) {
  const dir = path.join(DATA_DIR, "raw", "overture", release);
  return {
    dir,
    parquet: path.join(dir, `places-${COUNTY.key}.parquet`),
    boundaryZip: path.join(DATA_DIR, "raw", "boundary", "cb_2023_us_county_500k.zip"),
  };
}

export interface OvertureLoadOptions {
  runId: string;
  release?: string | undefined;
  /** Re-extract even if the release parquet already exists. */
  force?: boolean;
}

/**
 * Extract county-clipped places for the pinned release (once per release),
 * then (re)load `raw_overture_places`.
 */
export async function loadOverturePlaces(
  db: Db,
  opts: OvertureLoadOptions,
): Promise<SourceRunResult> {
  const started = Date.now();
  const release = opts.release ?? OVERTURE_RELEASE;
  const p = overturePaths(release);
  const log = logger.child({ stage: "overture", release });
  const fetchedAt = new Date().toISOString();
  const limitations = [
    "Overture is a numerator (places it knows about), not an authoritative count of all businesses; expected_count is NULL by design.",
    "Rows sourced from OpenStreetMap are excluded (licence gate from the kit's overture-places-ingest skill).",
    "Category semantics are release-specific; every row is stamped with the Overture release.",
  ];

  await downloadFile(CENSUS_COUNTY_ZIP_URL, p.boundaryZip);
  await db.run("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;");
  await db.run("SET s3_region='us-west-2';");

  let bboxCount: number | null = null;
  if (opts.force || !(await exists(p.parquet))) {
    await (await import("node:fs/promises")).mkdir(p.dir, { recursive: true });
    const boundary = `/vsizip/${p.boundaryZip}/cb_2023_us_county_500k.shp`;
    log.info("extracting county-clipped places from S3 (this is the slow step)");
    await db.run(`CREATE OR REPLACE TEMP TABLE county_boundary AS
      SELECT geom AS geometry FROM ST_Read(${lit(boundary)}) WHERE GEOID = ${lit(COUNTY.fips)}`);
    await db.run(`CREATE OR REPLACE TEMP TABLE county_bbox AS
      SELECT ST_XMin(ST_Extent(geometry)) AS xmin, ST_XMax(ST_Extent(geometry)) AS xmax,
             ST_YMin(ST_Extent(geometry)) AS ymin, ST_YMax(ST_Extent(geometry)) AS ymax FROM county_boundary`);
    await db.run(`COPY (
      SELECT
        p.id AS gers_id, p.version AS overture_version, p.names.primary AS name_primary,
        p.taxonomy.primary AS taxonomy_primary, array_to_string(p.taxonomy.hierarchy, '/') AS taxonomy_hierarchy,
        p.taxonomy.alternates AS taxonomy_alternates, p.basic_category AS basic_category,
        p.categories.primary AS legacy_category_primary, p.operating_status AS operating_status, p.confidence AS confidence,
        p.websites AS websites, p.phones AS phones, p.emails AS emails, p.brand.names.primary AS brand_name,
        p.addresses[1].freeform AS address_freeform, p.addresses[1].locality AS address_locality,
        p.addresses[1].postcode AS address_postcode, p.addresses[1].region AS address_region,
        list_transform(p.sources, s -> s.dataset) AS source_datasets,
        ST_X(p.geometry) AS longitude, ST_Y(p.geometry) AS latitude,
        ${lit(release)} AS overture_release, ${lit(COUNTY.fips)} AS county_fips,
        p.bbox.xmin >= b.xmin AS in_bbox
      FROM read_parquet(${lit(OVERTURE_PLACES_GLOB(release))}, hive_partitioning = 1) AS p, county_bbox AS b, county_boundary AS c
      WHERE p.bbox.xmin >= b.xmin AND p.bbox.xmax <= b.xmax AND p.bbox.ymin >= b.ymin AND p.bbox.ymax <= b.ymax
        AND ST_Within(p.geometry, c.geometry)
    ) TO ${lit(p.parquet)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    log.info({ ms: Date.now() - started }, "extract done");
  }

  // Load with the licence gate applied; keep the excluded count for the run record.
  await db.run(`CREATE OR REPLACE TABLE raw_overture_places AS
    SELECT *, ${lit(fetchedAt)}::TIMESTAMP AS fetched_at, ${lit(opts.runId)} AS loaded_run_id
    FROM read_parquet(${lit(p.parquet)})
    WHERE NOT list_has_any(list_transform(coalesce(source_datasets, []), d -> lower(d)), ['openstreetmap', 'osm'])`);
  const total = Number(
    (
      await db.one<{ n: bigint | number }>(
        `SELECT count(*) AS n FROM read_parquet(${lit(p.parquet)})`,
      )
    )?.n ?? 0,
  );
  const kept = await db.count("raw_overture_places");
  bboxCount = total;
  const digest = await sha256File(p.parquet);
  await recordLoad(db, {
    runId: opts.runId,
    source: "overture_places",
    item: `places-${COUNTY.key}.parquet`,
    url: OVERTURE_SOURCE_URL(release),
    digest,
    bytes: (await stat(p.parquet)).size,
    rows: kept,
    fetchedAt,
    notes: `release=${release}; clipped=${total}; excluded_osm=${total - kept}`,
  });
  log.info({ clipped: total, kept, excluded: total - kept }, "overture places loaded");

  return {
    source: "overture_places",
    status: "ok",
    fetchedAt,
    window: { release },
    recordsSeen: bboxCount,
    recordsNew: kept,
    recordsChanged: 0,
    recordsQuarantined: total - kept,
    durationMs: Date.now() - started,
    requestCount: null,
    urls: [OVERTURE_SOURCE_URL(release), OVERTURE_PLACES_GLOB(release)],
    limitations,
    error: null,
  };
}
