/**
 * BBB (Better Business Bureau) roofing-contractor profile harvester for the
 * Osceola County service area.
 *
 * Public surface: {@link harvestBbb} for callers, the pure parsers
 * ({@link parseCategoryPage}, {@link parseSearchResult}, {@link parseProfilePage})
 * and the normalisers for tests and downstream matching. Output validates
 * against `BbbProfileRecord` from `@osceola/shared` and is loaded by
 * `duckdb/load-harvests.ts` into `raw_bbb_profiles`.
 *
 * @module sources/bbb
 */
export {
  harvestBbb,
  DEFAULT_CITIES,
  DEFAULT_CATEGORIES,
  DEFAULT_SORTS,
  BBB_PAGE_CAP,
  type BbbHarvestOptions,
  type BbbHarvestSummaryShape,
  type BbbHarvestFailure,
} from "./harvest.js";
export {
  parseCategoryPage,
  parseSearchResult,
  buildCategoryUrl,
  buildSearchApiPath,
  type CategoryListing,
  type ListingResult,
  type SearchApiParams,
} from "./category.js";
export { parseProfilePage, ProfileParseError, type ParsedProfile, type ParsedProfileRecord, type ProfileExtras } from "./profile.js";
export {
  openBbbSession,
  isChallengeHtml,
  percentile,
  sleep,
  jitter,
  BbbChallengeError,
  BbbHttpError,
  DEFAULT_USER_AGENT,
  type BbbSession,
  type BbbSessionOptions,
  type FetchedPage,
  type FetchedJson,
  type SessionStats,
} from "./browser.js";
export {
  parseBbbId,
  bbbIdFromUrl,
  canonicalProfileUrl,
  normalizePhone,
  normalizeLicense,
  extractLicenseNumbers,
  mergeLicenseNumbers,
  normalizeRating,
  stripTags,
  slugToTitle,
  BBB_ORIGIN,
  type BbbIdParts,
} from "./normalize.js";
export { extractPreloadedState } from "./preloaded-state.js";
