/**
 * Loaders for harvester output (JSONL validated against `@osceola/shared`
 * contracts) into the DuckDB raw layer:
 *
 * - `raw_accela_permits` <- `data/raw/accela/<window>/permits.jsonl` (many windows)
 * - `raw_bbb_profiles`   <- `data/raw/bbb/<job>/profiles.jsonl`
 *
 * Both are upserts keyed by the source's natural key, so re-loading a window is
 * idempotent and a re-harvest with changed content replaces the old row (the
 * `raw_html_sha256` column tells the two apart).
 *
 * @module duckdb/load-harvests
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { sha256File } from "../util/fs.js";
import type { Db } from "./client.js";
import { lit } from "./client.js";
import { recordLoad } from "./ledger.js";

/** Find every `fileName` one directory level below `root` (one sub-directory per harvest window). */
async function findHarvestFiles(root: string, fileName: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const f = path.join(root, e.name, fileName);
      try {
        if ((await stat(f)).isFile()) files.push(f);
      } catch {
        /* window without output */
      }
    }
    return files.sort();
  } catch {
    return [];
  }
}

export async function ensureAccelaTable(db: Db): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS raw_accela_permits (
      permit_number VARCHAR PRIMARY KEY,
      cap_id1 VARCHAR, cap_id2 VARCHAR, cap_id3 VARCHAR,
      record_type VARCHAR, status VARCHAR,
      opened_date VARCHAR, issued_date VARCHAR, expiration_date VARCHAR, finaled_date VARCHAR, closed_date VARCHAR,
      description VARCHAR, job_value DOUBLE, parcel_number VARCHAR, address VARCHAR,
      contractor_name VARCHAR, contractor_business_name VARCHAR, contractor_license VARCHAR,
      contractor_license_type VARCHAR, contractor_phone VARCHAR, contractor_address VARCHAR,
      source_url VARCHAR, fetched_at VARCHAR, raw_html_sha256 VARCHAR, raw_html_path VARCHAR,
      harvest_dir VARCHAR, loaded_run_id VARCHAR)`);
}

/**
 * Load every Accela harvest window under `data/raw/accela/`.
 * Returns rows seen / new / changed for the run summary.
 */
export async function loadAccelaHarvests(
  db: Db,
  runId: string,
  root = path.join(DATA_DIR, "raw", "accela"),
): Promise<{ files: number; seen: number; inserted: number; changed: number }> {
  await ensureAccelaTable(db);
  const files = await findHarvestFiles(root, "permits.jsonl");
  let seen = 0;
  let inserted = 0;
  let changed = 0;
  for (const file of files) {
    const before = await db.count("raw_accela_permits");
    await db.run(`CREATE OR REPLACE TEMP TABLE accela_in AS
      SELECT * FROM read_json(${lit(file)}, format='newline_delimited', union_by_name=true, maximum_object_size=4194304,
        columns={permitNumber:'VARCHAR', capId:'STRUCT(capID1 VARCHAR, capID2 VARCHAR, capID3 VARCHAR)', recordType:'VARCHAR', status:'VARCHAR',
                 openedDate:'VARCHAR', issuedDate:'VARCHAR', expirationDate:'VARCHAR', finaledDate:'VARCHAR', closedDate:'VARCHAR',
                 description:'VARCHAR', jobValue:'DOUBLE', parcelNumber:'VARCHAR', address:'VARCHAR',
                 contractor:'STRUCT(name VARCHAR, businessName VARCHAR, licenseNumber VARCHAR, licenseType VARCHAR, phone VARCHAR, address VARCHAR)',
                 sourceUrl:'VARCHAR', fetchedAt:'VARCHAR', rawHtmlSha256:'VARCHAR', rawHtmlPath:'VARCHAR'})`);
    const n = await db.count("accela_in");
    const chg = await db.one<{ n: bigint | number }>(`
      SELECT count(*) AS n FROM accela_in i JOIN raw_accela_permits r ON r.permit_number = i.permitNumber
      WHERE r.raw_html_sha256 <> i.rawHtmlSha256`);
    await db.run(`
      INSERT OR REPLACE INTO raw_accela_permits
      SELECT permitNumber, capId.capID1, capId.capID2, capId.capID3, recordType, status,
             openedDate, issuedDate, expirationDate, finaledDate, closedDate, description, jobValue, parcelNumber, address,
             contractor.name, contractor.businessName, contractor.licenseNumber, contractor.licenseType, contractor.phone, contractor.address,
             sourceUrl, fetchedAt, rawHtmlSha256, rawHtmlPath, ${lit(path.dirname(file))}, ${lit(runId)}
      FROM accela_in
      QUALIFY row_number() OVER (PARTITION BY permitNumber ORDER BY fetchedAt DESC) = 1`);
    const after = await db.count("raw_accela_permits");
    seen += n;
    inserted += after - before;
    changed += Number(chg?.n ?? 0);
    await recordLoad(db, {
      runId,
      source: "osceola_accela",
      item: path.relative(root, file),
      url: "https://permits.osceola.org/CitizenAccess/",
      digest: await sha256File(file),
      bytes: (await stat(file)).size,
      rows: n,
      fetchedAt: new Date().toISOString(),
      notes: null,
    });
  }
  return { files: files.length, seen, inserted, changed };
}

export async function ensureBbbTable(db: Db): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS raw_bbb_profiles (
      bbb_id VARCHAR PRIMARY KEY, name VARCHAR, rating VARCHAR, accredited BOOLEAN, rating_score DOUBLE,
      review_count INTEGER, complaint_count INTEGER, phone VARCHAR, address VARCHAR, city VARCHAR, state VARCHAR, zip VARCHAR,
      license_numbers VARCHAR[], categories VARCHAR[], profile_url VARCHAR, fetched_at VARCHAR, raw_html_sha256 VARCHAR,
      harvest_dir VARCHAR, loaded_run_id VARCHAR)`);
}

/**
 * Load every BBB harvest under `data/raw/bbb/`.
 *
 * Two record shapes are merged per harvest directory: `profiles.jsonl` (full
 * profile pages: license numbers, review/complaint counts, address) and
 * `listings.jsonl` (category listing cards: rating, score, accreditation,
 * phones). Listings are the fallback for businesses whose profile page has not
 * been fetched yet, so ratings are available as soon as the listing phase is
 * done; a later profile fetch replaces the listing-derived row.
 */
export async function loadBbbHarvests(
  db: Db,
  runId: string,
  root = path.join(DATA_DIR, "raw", "bbb"),
): Promise<{ files: number; seen: number; inserted: number }> {
  await ensureBbbTable(db);
  const files = await findHarvestFiles(root, "profiles.jsonl");
  let seen = 0;
  let inserted = 0;
  for (const file of files) {
    const before = await db.count("raw_bbb_profiles");
    const listings = path.join(path.dirname(file), "listings.jsonl");
    const hasListings = await stat(listings)
      .then((s) => s.isFile())
      .catch(() => false);
    await db.run(`CREATE OR REPLACE TEMP TABLE bbb_in AS
      SELECT * FROM read_json(${lit(file)}, format='newline_delimited', union_by_name=true,
        columns={bbbId:'VARCHAR', name:'VARCHAR', rating:'VARCHAR', accredited:'BOOLEAN', ratingScore:'DOUBLE', reviewCount:'INTEGER',
                 complaintCount:'INTEGER', phone:'VARCHAR', address:'VARCHAR', city:'VARCHAR', state:'VARCHAR', zip:'VARCHAR',
                 licenseNumbers:'VARCHAR[]', categories:'VARCHAR[]', profileUrl:'VARCHAR', fetchedAt:'VARCHAR', rawHtmlSha256:'VARCHAR'})
      ${
        hasListings
          ? `UNION ALL BY NAME
      SELECT bbbId, name, rating, accredited, ratingScore, NULL::INTEGER AS reviewCount, NULL::INTEGER AS complaintCount,
             phones[1] AS phone, NULL::VARCHAR AS address, city, state, postalCode AS zip, []::VARCHAR[] AS licenseNumbers,
             categories, profileUrl, ${lit(new Date().toISOString())} AS fetchedAt, NULL::VARCHAR AS rawHtmlSha256
      FROM read_json(${lit(listings)}, format='newline_delimited', union_by_name=true,
        columns={bbbId:'VARCHAR', name:'VARCHAR', rating:'VARCHAR', accredited:'BOOLEAN', ratingScore:'DOUBLE', phones:'VARCHAR[]',
                 city:'VARCHAR', state:'VARCHAR', postalCode:'VARCHAR', categories:'VARCHAR[]', profileUrl:'VARCHAR'})
      WHERE bbbId NOT IN (SELECT bbbId FROM read_json(${lit(file)}, format='newline_delimited', union_by_name=true, columns={bbbId:'VARCHAR'}))`
          : ""
      }`);
    const n = await db.count("bbb_in");
    await db.run(`
      INSERT OR REPLACE INTO raw_bbb_profiles
      SELECT bbbId, name, rating, accredited, ratingScore, reviewCount, complaintCount, phone, address, city, state, zip,
             licenseNumbers, categories, profileUrl, fetchedAt, rawHtmlSha256, ${lit(path.dirname(file))}, ${lit(runId)}
      FROM bbb_in QUALIFY row_number() OVER (PARTITION BY bbbId ORDER BY (rawHtmlSha256 IS NOT NULL) DESC, fetchedAt DESC) = 1`);
    seen += n;
    inserted += (await db.count("raw_bbb_profiles")) - before;
    await recordLoad(db, {
      runId,
      source: "bbb_roofing",
      item: path.relative(root, file),
      url: "https://www.bbb.org/",
      digest: await sha256File(file),
      bytes: (await stat(file)).size,
      rows: n,
      fetchedAt: new Date().toISOString(),
      notes: null,
    });
  }
  return { files: files.length, seen, inserted };
}
