/**
 * Pipeline runtime configuration.
 *
 * Everything is resolved from environment variables with safe defaults so the
 * same code runs on a laptop, in GitHub Actions, and in a one-off container.
 * Secrets (Filebase keys) are read here and never logged.
 *
 * @module config
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OSCEOLA } from "@osceola/shared";

/** Repository root (this file lives at packages/pipeline/src/config.ts). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Where raw downloads, harvests and the DuckDB database live (gitignored). */
export const DATA_DIR = process.env.OSCEOLA_DATA_DIR ?? path.join(REPO_ROOT, "data");
/** Where committed run outputs live (manifests, run history, verification reports). */
export const ARTIFACTS_DIR = process.env.OSCEOLA_ARTIFACTS_DIR ?? path.join(REPO_ROOT, "artifacts");
/** The DuckDB database file holding raw + reconciled tables. */
export const DUCKDB_PATH = process.env.OSCEOLA_DUCKDB_PATH ?? path.join(DATA_DIR, "osceola.duckdb");

export const COUNTY = OSCEOLA;

/**
 * OCPA certified-roll ZIPs by tax year (public Dropbox links published on
 * https://www.property-appraiser.org/data/). The pipeline verifies each file's
 * SHA-256 after download and records it as source provenance.
 */
export const OCPA_CERTIFIED_ZIPS: Readonly<Record<number, string>> = {
  2025: "https://www.dropbox.com/scl/fi/zxmxctjxkkontl6jww2qz/2025_CertifiedData_OCPA.zip?rlkey=2bxf6ef5my1k4jkx8jjynwxtx&st=m40wer6o&dl=1",
  2024: "https://www.dropbox.com/scl/fi/9jqm00qv7etbma1ftylee/2024_CertifiedData_OCPA.zip?rlkey=9xhydeim8ochpbfcqvxd3m0bo&st=2ta3hoj5&dl=1",
  2023: "https://www.dropbox.com/scl/fi/ujo9eh9126jyrf8wf4evp/2023_CertifiedData_OCPA.zip?rlkey=37gwt4mkg9vv2d0khlbz5jxdn&dl=1",
};

/** Default tax year to load (latest certified export). */
export const DEFAULT_TAX_YEAR = Number(process.env.OSCEOLA_TAX_YEAR ?? 2025);

/**
 * Public IPFS gateways this project does NOT operate, used for the
 * independent-retrieval proof. Filebase's gateway is deliberately excluded here
 * because it is the pinning vendor. Four are listed because ipfs.io and
 * dweb.link rate-limit shared IPs (VPN exits, CI runners) with HTTP 429; an
 * artifact is proven when at least two of them return matching bytes.
 */
export const VERIFY_GATEWAYS = (
  process.env.OSCEOLA_VERIFY_GATEWAYS ??
  "https://ipfs.io,https://dweb.link,https://gateway.pinata.cloud,https://w3s.link"
)
  .split(",")
  .map((g) => g.trim())
  .filter(Boolean);

/** Filebase (IPFS pinning) settings; credentials come from the environment only. */
export const FILEBASE = {
  s3Endpoint: process.env.FILEBASE_S3_ENDPOINT ?? "https://s3.filebase.com",
  namesApi: "https://api.filebase.io/v1/names",
  gateway: process.env.FILEBASE_GATEWAY ?? "https://ipfs.filebase.io",
  bucket: process.env.S3_BUCKET ?? process.env.FILEBASE_BUCKET ?? "",
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? process.env.FILEBASE_ACCESS_KEY ?? "",
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? process.env.FILEBASE_SECRET_KEY ?? "",
  /** IPNS label for the "latest run" pointer; the resolved CID is what consumers store. */
  ipnsLabel: process.env.FILEBASE_IPNS_LABEL ?? `oracle-osceola-runs`,
} as const;

/** True when a live publish is possible. */
export function hasFilebaseCredentials(): boolean {
  return Boolean(FILEBASE.bucket && FILEBASE.accessKeyId && FILEBASE.secretAccessKey);
}

/** Generates a sortable run id: `2026-09-07T10-41-12Z-full`. */
export function newRunId(mode: "full" | "incremental", now = new Date()): string {
  return `${now
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z")}-${mode}`;
}
