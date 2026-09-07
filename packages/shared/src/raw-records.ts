/**
 * Zod schemas for records produced by the *harvesting* stages before they are
 * loaded into DuckDB. Harvesters write JSONL files with these shapes; loaders
 * validate them on the way in. Keeping the shape in one place lets the Accela
 * harvester, its tests, and the DuckDB loader evolve together.
 *
 * @module raw-records
 */
import { z } from "zod";

/** ISO-8601 date string `YYYY-MM-DD` or null. */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

/**
 * One permit as harvested from the Accela Citizen Access portal.
 * Fields mirror the CapDetail page; anything not present on the page is null.
 */
export const AccelaPermitRecord = z.object({
  /** Portal record number, e.g. `ROF26-006408`. */
  permitNumber: z.string().min(1),
  /** Accela capID triple, kept for exact re-fetch. */
  capId: z.object({ capID1: z.string(), capID2: z.string(), capID3: z.string() }),
  /** Record type label as shown in search results / detail header, e.g. `Roofing Permit`. */
  recordType: z.string().nullable(),
  status: z.string().nullable(),
  /** Search-result "Date" column (application/open date). */
  openedDate: isoDate,
  issuedDate: isoDate,
  expirationDate: isoDate,
  finaledDate: isoDate,
  closedDate: isoDate,
  description: z.string().nullable(),
  jobValue: z.number().nullable(),
  /** Parcel number exactly as shown on the portal (normalized separately). */
  parcelNumber: z.string().nullable(),
  address: z.string().nullable(),
  /** Licensed professional / contractor block. */
  contractor: z
    .object({
      name: z.string().nullable(),
      businessName: z.string().nullable(),
      licenseNumber: z.string().nullable(),
      licenseType: z.string().nullable(),
      phone: z.string().nullable(),
      address: z.string().nullable(),
    })
    .nullable(),
  /** Absolute portal URL of the detail page (provenance). */
  sourceUrl: z.string().url(),
  /** When the detail page was fetched (ISO timestamp). */
  fetchedAt: z.string().datetime(),
  /** SHA-256 of the raw detail HTML (change detection across runs). */
  rawHtmlSha256: z.string().length(64),
  /** Path of the archived raw HTML relative to the harvest directory. */
  rawHtmlPath: z.string(),
});
export type AccelaPermitRecord = z.infer<typeof AccelaPermitRecord>;

/** Summary written next to `permits.jsonl` by the Accela harvester. */
export const AccelaHarvestSummary = z.object({
  window: z.object({ since: z.string(), until: z.string() }),
  recordType: z.string(),
  searchHits: z.number().int().nonnegative(),
  /** True when the portal's 100-hit cap was reached and the window must be split. */
  capped: z.boolean(),
  detailsFetched: z.number().int().nonnegative(),
  detailsFailed: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  requestCount: z.number().int().nonnegative(),
  p50LatencyMs: z.number().nonnegative(),
  p95LatencyMs: z.number().nonnegative(),
});
export type AccelaHarvestSummary = z.infer<typeof AccelaHarvestSummary>;

/** One parcel centroid from the county GIS layer. */
export const GisParcelRecord = z.object({
  objectId: z.number().int(),
  parcelNo: z.string(),
  displayStrap: z.string().nullable(),
  latitude: z.number(),
  longitude: z.number(),
  yearBuilt: z.number().int().nullable(),
  dorCode: z.string().nullable(),
  locCity: z.string().nullable(),
  locZip: z.string().nullable(),
  lastUpdate: z.string().nullable(),
  acres: z.number().nullable(),
  fetchedAt: z.string().datetime(),
});
export type GisParcelRecord = z.infer<typeof GisParcelRecord>;

/** One BBB business profile (roofing contractors). */
export const BbbProfileRecord = z.object({
  bbbId: z.string(),
  name: z.string(),
  rating: z.string().nullable(),
  accredited: z.boolean().nullable(),
  ratingScore: z.number().nullable(),
  reviewCount: z.number().int().nullable(),
  complaintCount: z.number().int().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  licenseNumbers: z.array(z.string()),
  categories: z.array(z.string()),
  profileUrl: z.string().url(),
  fetchedAt: z.string().datetime(),
  rawHtmlSha256: z.string().length(64),
});
export type BbbProfileRecord = z.infer<typeof BbbProfileRecord>;
