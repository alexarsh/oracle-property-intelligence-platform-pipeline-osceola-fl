/**
 * OCPA certified-roll ingestion.
 *
 * The Osceola County Property Appraiser publishes one ZIP per tax year with the
 * full certified roll as pipe-delimited CSVs (parcels, owners, mailing
 * addresses, situs, buildings, permits, sales back to 1930, the FDOR NAL file,
 * and lookup tables). This stage downloads the ZIP, verifies its digest,
 * extracts it, and loads every file we use into DuckDB `raw_ocpa_*` tables
 * with all columns as VARCHAR plus provenance columns. Typing and cleaning
 * happen later in `transform/` so the raw layer stays a faithful copy.
 *
 * Malformed rows (the export contains ~21k truncated permit rows) are captured
 * by DuckDB's reject tables and reported, never silently dropped.
 *
 * @module sources/appraiser
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { stat } from "node:fs/promises";
import type { SourceRunResult } from "@osceola/shared";
import { DATA_DIR, OCPA_CERTIFIED_ZIPS, COUNTY } from "../../config.js";
import type { Db } from "../../duckdb/client.js";
import { lit } from "../../duckdb/client.js";
import { recordLoad } from "../../duckdb/ledger.js";
import { logger } from "../../logger.js";
import { downloadFile, exists, sha256File } from "../../util/fs.js";

const execFileAsync = promisify(execFile);

/**
 * Files we load, mapped to DuckDB table names. Everything else in the ZIP is
 * lookup/valuation detail that the roofing use-case does not need yet; the ZIP
 * is archived so they can be added without re-downloading.
 */
export const OCPA_FILES: Readonly<Record<string, string>> = {
  "vw_mdparcel.csv": "raw_ocpa_parcel",
  "vw_mdsite.csv": "raw_ocpa_site",
  "vw_mdowner.csv": "raw_ocpa_owner",
  "vw_mdmail.csv": "raw_ocpa_mail",
  "vw_mdBld.csv": "raw_ocpa_building",
  "vw_mdpermit.csv": "raw_ocpa_permit",
  "vw_mdsales1930.csv": "raw_ocpa_sales",
  "vw_mdDetail.csv": "raw_ocpa_detail",
  "vw_mdLegal_ln.csv": "raw_ocpa_legal",
  "lu_dor.csv": "raw_ocpa_lu_dor",
  "lu_sub.csv": "raw_ocpa_lu_sub",
};

export interface AppraiserLoadOptions {
  taxYear: number;
  runId: string;
  /** Re-download even if the ZIP is already present. */
  forceDownload?: boolean;
  /** Re-load tables even if this tax year was already loaded. */
  forceReload?: boolean;
}

/** Local paths for one tax year's export. */
export function appraiserPaths(taxYear: number) {
  const dir = path.join(DATA_DIR, "raw", "ocpa", String(taxYear));
  return { dir, zip: path.join(dir, `${taxYear}_CertifiedData_OCPA.zip`), extracted: path.join(dir, "extracted") };
}

async function extractZip(zip: string, dest: string): Promise<void> {
  // `unzip` is available on macOS and on GitHub Actions runners; DuckDB cannot read inside archives.
  await execFileAsync("unzip", ["-o", "-q", zip, "-d", dest], { maxBuffer: 1024 * 1024 });
}

/** Find the extracted CSV regardless of the top-level folder name inside the ZIP. */
async function locate(extracted: string, taxYear: number, file: string): Promise<string> {
  const candidates = [path.join(extracted, `${taxYear}_CertifiedData_OCPA`, file), path.join(extracted, file)];
  for (const c of candidates) if (await exists(c)) return c;
  throw new Error(`OCPA file not found after extraction: ${file}`);
}

/**
 * Download + extract + load the certified roll for `taxYear`.
 * Idempotent: a second call with the same tax year is a no-op unless forced.
 */
export async function loadAppraiser(db: Db, opts: AppraiserLoadOptions): Promise<SourceRunResult> {
  const started = Date.now();
  const source = COUNTY.sources.ocpa_certified!;
  const url = OCPA_CERTIFIED_ZIPS[opts.taxYear];
  if (!url) throw new Error(`No OCPA certified export URL configured for tax year ${opts.taxYear}`);
  const p = appraiserPaths(opts.taxYear);
  const log = logger.child({ stage: "appraiser", taxYear: opts.taxYear });

  const dl = await downloadFile(url, p.zip, { overwrite: opts.forceDownload ?? false });
  const digest = await sha256File(p.zip);
  log.info({ bytes: dl.bytes, downloaded: dl.downloaded, sha256: digest }, "certified export ready");

  await db.run(`CREATE TABLE IF NOT EXISTS ocpa_loaded (tax_year INTEGER PRIMARY KEY, zip_sha256 VARCHAR, loaded_at TIMESTAMP, run_id VARCHAR)`);
  const already = await db.one<{ zip_sha256: string }>(`SELECT zip_sha256 FROM ocpa_loaded WHERE tax_year = ?`, [opts.taxYear]);
  const fetchedAt = new Date().toISOString();
  if (already && already.zip_sha256 === digest && !opts.forceReload) {
    log.info("tax year already loaded with identical digest — skipping (idempotent)");
    return {
      source: source.key,
      status: "skipped",
      fetchedAt,
      window: { taxYear: String(opts.taxYear) },
      recordsSeen: 0,
      recordsNew: 0,
      recordsChanged: 0,
      recordsQuarantined: 0,
      durationMs: Date.now() - started,
      requestCount: dl.downloaded ? 1 : 0,
      urls: [source.url],
      limitations: [...source.limitations, "No new certified export since the previous run."],
      error: null,
    };
  }

  if (!(await exists(p.extracted))) await extractZip(p.zip, p.extracted);
  let seen = 0;
  let quarantined = 0;
  for (const [file, table] of Object.entries(OCPA_FILES)) {
    const csv = await locate(p.extracted, opts.taxYear, file);
    const { size } = await stat(csv);
    // all_varchar keeps the raw layer lossless; typing happens in transform/.
    // quote/escape disabled: the export is plain pipe-delimited with no quoting.
    await db.run(`DROP TABLE IF EXISTS ${table}`);
    await db.run(`
      CREATE TABLE ${table} AS
      SELECT *, ${opts.taxYear}::INTEGER AS tax_year, ${lit(file)} AS source_file, ${lit(opts.runId)} AS loaded_run_id
      FROM read_csv(${lit(csv)}, delim='|', header=true, quote='', escape='', encoding='latin-1',
                    all_varchar=true, ignore_errors=true, store_rejects=true, null_padding=true,
                    rejects_table='reject_errors', rejects_scan='reject_scans', max_line_size=4194304)`);
    const rows = await db.count(table);
    const rejected = await db.one<{ n: bigint | number }>(
      `SELECT count(*) AS n FROM reject_errors e JOIN reject_scans s USING (scan_id, file_id) WHERE s.file_path = ?`,
      [csv],
    );
    const nRej = Number(rejected?.n ?? 0);
    seen += rows;
    quarantined += nRej;
    await recordLoad(db, {
      runId: opts.runId,
      source: source.key,
      item: file,
      url,
      digest,
      bytes: size,
      rows,
      fetchedAt,
      notes: nRej > 0 ? `${nRej} malformed rows quarantined in reject_errors` : null,
    });
    log.info({ table, rows, rejected: nRej }, "loaded");
  }
  await db.run(`INSERT OR REPLACE INTO ocpa_loaded VALUES (?, ?, ?::TIMESTAMP, ?)`, [opts.taxYear, digest, fetchedAt, opts.runId]);

  return {
    source: source.key,
    status: "ok",
    fetchedAt,
    window: { taxYear: String(opts.taxYear) },
    recordsSeen: seen,
    recordsNew: already ? 0 : seen,
    recordsChanged: already ? seen : 0,
    recordsQuarantined: quarantined,
    durationMs: Date.now() - started,
    requestCount: dl.downloaded ? 1 : 0,
    urls: [source.url, url.split("?")[0]!],
    limitations: [...source.limitations],
    error: null,
  };
}
