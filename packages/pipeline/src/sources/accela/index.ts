/**
 * Osceola County Accela Citizen Access permit harvester.
 *
 * Public surface: {@link harvestRange} / {@link harvestWindow} for callers,
 * the pure parsers ({@link parseSearchResults}, {@link parseCapDetail}) and
 * normalisers for tests and downstream loaders.
 *
 * @module sources/accela
 */
export { harvestRange, harvestWindow, bisectWindow, type HarvestWindowSummary } from "./harvest.js";
export {
  parseSearchResults,
  parseAjaxDelta,
  isAjaxDelta,
  extractHiddenFields,
  buildSearchForm,
  buildPagerForm,
  iterateSearchPages,
  capIdFromUrl,
  postbackTarget,
  SearchProtocolError,
  type AjaxDelta,
  type SearchParams,
} from "./search.js";
export { parseCapDetail, parseCapDetailExtended, parseLicensedProfessional, DetailParseError } from "./detail.js";
export { normalizeParcelNumber, normalizePhone, toIsoDate, toPortalDate, parseMoney, cleanText } from "./normalize.js";
export {
  createAccelaClient,
  createPinnedDispatcher,
  classifyStatus,
  percentile,
  TransientHttpError,
  PermanentHttpError,
  type AccelaClient,
  type AccelaClientOptions,
  type HttpResult,
} from "./client.js";
export {
  DEFAULT_RECORD_TYPE,
  PORTAL_HIT_CAP,
  PAGE_SIZE,
  PORTAL_BASE_URL,
  CAP_HOME_URL,
  type AccelaHarvestOptions,
  type CapId,
  type SearchRow,
  type SearchPage,
  type PermitDetail,
  type ParsedCapDetail,
  type HarvestFailure,
} from "./types.js";
