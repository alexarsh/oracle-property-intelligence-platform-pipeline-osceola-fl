/**
 * Source-load ledger: one row per (run, source, file) recording exactly which
 * bytes were ingested, when, and from where. This is the provenance backbone
 * every published row points back to through `source_system` / `source_url`.
 *
 * @module duckdb/ledger
 */
import type { Db } from "./client.js";

export interface LedgerEntry {
  runId: string;
  source: string;
  /** Logical file / endpoint name within the source. */
  item: string;
  url: string;
  /** sha256 hex of the bytes ingested (zip, JSONL, or response body). */
  digest: string | null;
  bytes: number | null;
  rows: number | null;
  fetchedAt: string;
  notes: string | null;
}

export async function ensureLedger(db: Db): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS source_loads (
      run_id VARCHAR NOT NULL,
      source VARCHAR NOT NULL,
      item VARCHAR NOT NULL,
      url VARCHAR,
      digest VARCHAR,
      bytes BIGINT,
      rows BIGINT,
      fetched_at TIMESTAMP NOT NULL,
      notes VARCHAR,
      PRIMARY KEY (run_id, source, item)
    )`);
}

export async function recordLoad(db: Db, e: LedgerEntry): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO source_loads (run_id, source, item, url, digest, bytes, rows, fetched_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?::TIMESTAMP, ?)`,
    [e.runId, e.source, e.item, e.url, e.digest, e.bytes, e.rows, e.fetchedAt, e.notes],
  );
}
