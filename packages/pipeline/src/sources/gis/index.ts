/**
 * Osceola County GIS parcel centroids.
 *
 * The appraiser export carries no coordinates, so radius search needs the county
 * GIS "Parcels" feature layer (ArcGIS Online). We sweep the layer in pages of
 * 2,000 features, ask the server for centroids in WGS84, and persist JSONL plus
 * a checkpoint so an interrupted sweep resumes where it stopped. Incremental
 * runs can restrict the sweep with a `LastUpdate` window.
 *
 * @module sources/gis
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GisParcelRecord, type SourceRunResult } from "@osceola/shared";
import { COUNTY, DATA_DIR } from "../../config.js";
import type { Db } from "../../duckdb/client.js";
import { lit } from "../../duckdb/client.js";
import { recordLoad } from "../../duckdb/ledger.js";
import { logger } from "../../logger.js";
import { exists, readJson, sha256File, writeJson } from "../../util/fs.js";

const LAYER_URL = COUNTY.sources.osceola_gis_parcels!.url;
const PAGE = 2000;
const OUT_FIELDS = [
  "OBJECTID_1",
  "PARCELNO",
  "Dsp_strap",
  "YearBuilt",
  "DORCode",
  "LocCity",
  "LocZip",
  "LastUpdate",
  "TotalAcres",
];

interface Feature {
  attributes: Record<string, unknown>;
  centroid?: { x: number; y: number };
}
interface QueryResponse {
  features?: Feature[];
  exceededTransferLimit?: boolean;
  error?: { code: number; message: string };
}

export interface GisSweepOptions {
  runId: string;
  /** Only parcels whose `LastUpdate` is on/after this ISO date (incremental). */
  updatedSince?: string | undefined;
  concurrency?: number;
  fetchImpl?: typeof fetch;
}

function epochMsToIso(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v)
    ? new Date(v).toISOString().slice(0, 10)
    : null;
}
function str(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Convert one ArcGIS feature (with centroid) into the raw contract record. */
export function featureToRecord(f: Feature, fetchedAt: string): GisParcelRecord | null {
  const a = f.attributes;
  if (!f.centroid || typeof a.OBJECTID_1 !== "number") return null;
  const parcelNo = str(a.PARCELNO);
  if (!parcelNo) return null;
  const yb = num(a.YearBuilt);
  return GisParcelRecord.parse({
    objectId: a.OBJECTID_1,
    parcelNo,
    displayStrap: str(a.Dsp_strap),
    latitude: f.centroid.y,
    longitude: f.centroid.x,
    yearBuilt: yb && yb > 1700 && yb <= new Date().getFullYear() + 1 ? Math.trunc(yb) : null,
    dorCode: str(a.DORCode),
    locCity: str(a.LocCity),
    locZip: str(a.LocZip),
    lastUpdate: epochMsToIso(a.LastUpdate),
    acres: num(a.TotalAcres),
    fetchedAt,
  });
}

async function fetchPage(
  fetchImpl: typeof fetch,
  where: string,
  offset: number,
): Promise<QueryResponse> {
  const params = new URLSearchParams({
    where,
    outFields: OUT_FIELDS.join(","),
    returnGeometry: "false",
    returnCentroid: "true",
    outSR: "4326",
    orderByFields: "OBJECTID_1",
    resultOffset: String(offset),
    resultRecordCount: String(PAGE),
    f: "json",
  });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchImpl(`${LAYER_URL}/query?${params.toString()}`, {
        headers: { "User-Agent": "oracle-osceola-pipeline/0.1" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as QueryResponse;
      if (body.error) throw new Error(`ArcGIS error ${body.error.code}: ${body.error.message}`);
      return body;
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

export function gisPaths(runId: string) {
  const dir = path.join(DATA_DIR, "raw", "gis", runId);
  return {
    dir,
    jsonl: path.join(dir, "parcels.jsonl"),
    checkpoint: path.join(dir, "checkpoint.json"),
  };
}

/**
 * Sweep the layer to JSONL (resumable), then load/merge into `raw_gis_parcels`.
 * Rows are keyed by `parcelNo`; a re-sweep replaces rows with the same key.
 */
export async function loadGisParcels(db: Db, opts: GisSweepOptions): Promise<SourceRunResult> {
  const started = Date.now();
  const source = COUNTY.sources.osceola_gis_parcels!;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = logger.child({ stage: "gis" });
  const p = gisPaths(opts.runId);
  await mkdir(p.dir, { recursive: true });
  const where = opts.updatedSince ? `LastUpdate >= DATE '${opts.updatedSince}'` : "1=1";

  // Total for progress + expected-count reconciliation.
  const countRes = await fetchImpl(
    `${LAYER_URL}/query?where=${encodeURIComponent(where)}&returnCountOnly=true&f=json`,
  );
  const total = Number(((await countRes.json()) as { count?: number }).count ?? 0);
  log.info({ total, where }, "sweep start");

  let offset = 0;
  if (await exists(p.checkpoint))
    offset = (await readJson<{ offset: number }>(p.checkpoint)).offset;
  else await writeFile(p.jsonl, "");

  const fetchedAt = new Date().toISOString();
  let requests = 0;
  let written = 0;
  const concurrency = opts.concurrency ?? 4;
  while (offset < total) {
    const offsets = Array.from({ length: concurrency }, (_, i) => offset + i * PAGE).filter(
      (o) => o < total,
    );
    const pages = await Promise.all(offsets.map((o) => fetchPage(fetchImpl, where, o)));
    requests += pages.length;
    const lines: string[] = [];
    for (const page of pages) {
      for (const f of page.features ?? []) {
        const rec = featureToRecord(f, fetchedAt);
        if (rec) lines.push(JSON.stringify(rec));
      }
    }
    await appendFile(p.jsonl, lines.map((l) => `${l}\n`).join(""));
    written += lines.length;
    offset += offsets.length * PAGE;
    await writeJson(p.checkpoint, { offset, written, total });
    if (requests % 20 === 0) log.info({ offset, total, written }, "sweep progress");
  }
  log.info({ written, requests }, "sweep done");

  // Merge into the raw table (typed, keyed by parcel number).
  await db.run(`
    CREATE TABLE IF NOT EXISTS raw_gis_parcels (
      parcel_no VARCHAR PRIMARY KEY, object_id BIGINT, display_strap VARCHAR,
      latitude DOUBLE, longitude DOUBLE, year_built INTEGER, dor_code VARCHAR,
      loc_city VARCHAR, loc_zip VARCHAR, last_update DATE, acres DOUBLE,
      fetched_at TIMESTAMP, loaded_run_id VARCHAR)`);
  const before = await db.count("raw_gis_parcels");
  await db.run(`
    INSERT OR REPLACE INTO raw_gis_parcels
    SELECT parcelNo, objectId, displayStrap, latitude, longitude, yearBuilt, dorCode, locCity, locZip,
           TRY_CAST(lastUpdate AS DATE), acres, fetchedAt::TIMESTAMP, ${lit(opts.runId)}
    FROM read_json(${lit(p.jsonl)}, format='newline_delimited',
      columns={parcelNo:'VARCHAR', objectId:'BIGINT', displayStrap:'VARCHAR', latitude:'DOUBLE', longitude:'DOUBLE',
               yearBuilt:'INTEGER', dorCode:'VARCHAR', locCity:'VARCHAR', locZip:'VARCHAR', lastUpdate:'VARCHAR',
               acres:'DOUBLE', fetchedAt:'VARCHAR'})
    QUALIFY row_number() OVER (PARTITION BY parcelNo ORDER BY objectId DESC) = 1`);
  const after = await db.count("raw_gis_parcels");
  const digest = await sha256File(p.jsonl);
  await recordLoad(db, {
    runId: opts.runId,
    source: source.key,
    item: "parcels.jsonl",
    url: `${LAYER_URL}/query`,
    digest,
    bytes: (await readFile(p.jsonl)).length,
    rows: written,
    fetchedAt,
    notes: `where=${where}; expected=${total}`,
  });

  return {
    source: source.key,
    status: written >= total ? "ok" : "partial",
    fetchedAt,
    window: opts.updatedSince ? { updatedSince: opts.updatedSince } : null,
    recordsSeen: written,
    recordsNew: Math.max(after - before, 0),
    recordsChanged: Math.max(written - Math.max(after - before, 0), 0),
    recordsQuarantined: Math.max(total - written, 0),
    durationMs: Date.now() - started,
    requestCount: requests + 1,
    urls: [LAYER_URL],
    limitations: [...source.limitations],
    error: null,
  };
}
