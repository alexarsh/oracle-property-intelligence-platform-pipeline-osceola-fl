/**
 * Shared types and constants for the Osceola County Accela Citizen Access
 * permit harvester.
 *
 * @module sources/accela/types
 */
import type { AccelaPermitRecord } from "@osceola/shared";
import type { Logger } from "pino";

/** Default record type searched when the caller does not override it. */
export const DEFAULT_RECORD_TYPE = "Building/Permit/Roofing/NA";

/**
 * The portal never reports more than this many hits for one general search
 * ("Showing 1-10 of 100+"). Any window at or above the cap must be split.
 */
export const PORTAL_HIT_CAP = 100;

/** Result grid page size on the portal (not configurable from the client). */
export const PAGE_SIZE = 10;

/** Portal root; every relative link in the HTML is resolved against it. */
export const PORTAL_BASE_URL = "https://permits.osceola.org/CitizenAccess/";

/** General-search page for the Building module (GET for the form, POST for the async search). */
export const CAP_HOME_URL = `${PORTAL_BASE_URL}Cap/CapHome.aspx?module=Building&TabName=Building`;

/** Accela capID triple that uniquely identifies a record on the portal. */
export interface CapId {
  capID1: string;
  capID2: string;
  capID3: string;
}

/**
 * One row of the general-search result grid.
 *
 * Two kinds of rows appear: real records (linked record number, `capId` and
 * `detailUrl` set) and temporary/unsubmitted applications (`OSCTEMP26-…`,
 * hidden RecordId `26EST-…`) which have no detail page at all.
 */
export interface SearchRow {
  /** Record number as displayed (`A26-006408` or `OSCTEMP26-35056`). */
  permitNumber: string;
  /** Hidden `RecordId` input of the row, e.g. `REC26-00000-00U4X`. */
  recordId: string | null;
  /** Parsed from the detail link; null for list-only (temporary) rows. */
  capId: CapId | null;
  /** Absolute `CapDetail.aspx` URL; null for list-only rows. */
  detailUrl: string | null;
  /** "Date" column (ISO `YYYY-MM-DD`); the application/open date used for windowing. */
  date: string | null;
  recordType: string | null;
  projectName: string | null;
  address: string | null;
  status: string | null;
  description: string | null;
  /** "Expiration Date" column (ISO) — usually empty for open applications. */
  expirationDate: string | null;
  shortNote: string | null;
}

/** Parsed general-search result page. */
export interface SearchPage {
  rows: SearchRow[];
  /**
   * Total reported by "Showing a-b of N". `100` when the portal prints `100+`;
   * `0` when the portal says the search returned no results; null when the
   * caption could not be found.
   */
  total: number | null;
  /** True when a pager link to the following page exists. */
  hasNextPage: boolean;
  /** True when the caption carries the `+` cap marker or `total >= PORTAL_HIT_CAP`. */
  capped: boolean;
  /** `__EVENTTARGET` for the postback that loads the next page, when any. */
  nextPageTarget: string | null;
  /** 1-based page number highlighted in the pager (1 when no pager is rendered). */
  currentPage: number;
  /** `PageCount` attribute of the grid table (server-side page count), when present. */
  pageCount: number | null;
  /** The "a-b" part of the caption. */
  showing: { from: number; to: number } | null;
}

/** Options accepted by {@link harvestWindow} and {@link harvestRange}. */
export interface AccelaHarvestOptions {
  /** First application date, inclusive (`YYYY-MM-DD`). */
  since: string;
  /** Last application date, inclusive (`YYYY-MM-DD`). */
  until: string;
  /** Harvest directory; receives `permits.jsonl`, `summary.json`, `failures.jsonl` and `raw/`. */
  outDir: string;
  /** Portal record type value, default {@link DEFAULT_RECORD_TYPE}. */
  recordType?: string;
  /** Parallel detail fetches, default 2 (the portal degrades above ~4). Search paging is always sequential. */
  concurrency?: number;
  /** Minimum pause between two requests issued by the same worker, default 400 ms. */
  minDelayMs?: number;
  /** Skip re-fetching a detail page whose archived HTML still matches `raw/index.json`; default true. */
  skipExisting?: boolean;
  logger?: Logger;
  /** Injected fetch (tests). When set, the TLS-pinning dispatcher is not attached. */
  fetchImpl?: typeof fetch;
  /**
   * Base delay of the exponential retry backoff (default 750 ms; attempt n
   * waits `base * 2^(n-1)`). Exposed so tests can run retries without waiting.
   */
  retryBaseDelayMs?: number;
}

/** Detail-page fields; the harvester adds provenance (`fetchedAt`, sha, archive path). */
export type PermitDetail = Omit<AccelaPermitRecord, "fetchedAt" | "rawHtmlSha256" | "rawHtmlPath">;

/**
 * Everything the detail parser could read: the contract-shaped record plus the
 * "More Details" / application-information key-value pairs that have no home
 * in {@link AccelaPermitRecord} (kept so no data is dropped).
 */
export interface ParsedCapDetail {
  record: PermitDetail;
  /** Label → value pairs from "Application Information" / "Parcel Information" and contact extras. */
  extra: Record<string, string>;
}

/** One line of `failures.jsonl`. */
export interface HarvestFailure {
  permitNumber: string;
  url: string;
  error: string;
  /** Number of HTTP attempts made before giving up (0 for parse failures after a successful fetch). */
  attempt: number;
  /** `permanent` (404, parse error) or `transient` (retries exhausted). */
  kind: "permanent" | "transient";
}
