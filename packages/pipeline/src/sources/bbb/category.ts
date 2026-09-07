/**
 * Category listing parsing for BBB.
 *
 * A category URL (`/us/fl/<city>/category/<category>[?page=N]`) is a
 * location-biased search ("Roofing Contractors near Kissimmee, FL"). The
 * server-rendered page embeds the search response as
 * `__PRELOADED_STATE__.searchResult`; the same JSON is served by the
 * same-origin endpoint `/api/search?find_country=USA&find_text=…&find_loc=…&page=N[&sort=…]`.
 * {@link parseCategoryPage} handles the HTML, {@link parseSearchResult} the JSON;
 * both return the same {@link CategoryListing} shape.
 *
 * Hard limits observed live (2026-09-07): `pageSize` is fixed at 15,
 * `totalPages` is capped at 15 (page 16 → HTTP 500) even when `totalResults`
 * is in the thousands, so one (location, text, sort) tuple exposes at most
 * 225 businesses. Different `sort` values (`Relevance`, `Distance`, `Rating`,
 * `AToZ`, `ZToA`) expose different windows of the same pool.
 *
 * @module sources/bbb/category
 */
import * as cheerio from "cheerio";
import { asArray, asBoolean, asInt, asNumber, asObject, asString, extractPreloadedState, get } from "./preloaded-state.js";
import { BBB_ORIGIN, canonicalProfileUrl, normalizeRating, parseBbbId, stripTags } from "./normalize.js";

/** One business as it appears in a listing (search-result item). */
export interface ListingResult {
  /** `"<bureau>-<business>"`, e.g. `"0733-90573947"`. */
  bbbId: string;
  bureauId: string;
  businessId: string;
  name: string;
  /** Absolute canonical profile URL (may carry `/addressId/<n>`). */
  profileUrl: string;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  /** Letter rating shown in the listing, or `null` (NR). */
  rating: string | null;
  /** Numeric rating score (0–100) the search API exposes; profiles do not. */
  ratingScore: number | null;
  /** `bbbMember` flag from the listing (accreditation), or `null`. */
  accredited: boolean | null;
  /** Ten-digit phones are NOT normalised here; the raw strings are kept. */
  phones: string[];
  /** Category names attached to the business in the listing. */
  categories: string[];
  /** Type-of-business text BBB matched (`tobText`). */
  primaryCategory: string | null;
  /** BBB's own "out of business" marker when present. */
  outOfBusiness: boolean;
}

/** Parsed listing page (HTML or JSON). */
export interface CategoryListing {
  /** Unique profile URLs in listing order. */
  profileUrls: string[];
  /** True when BBB reports more pages after this one (bounded by the 15-page cap). */
  hasNext: boolean;
  page: number | null;
  totalPages: number | null;
  /** BBB's advertised total — much larger than what the 15-page cap lets you reach. */
  totalResults: number | null;
  results: ListingResult[];
  /** Text BBB searched for (`heading.searchInputText`), used for `/api/search?find_text=`. */
  searchText: string | null;
  /** Location BBB resolved (`heading.searchLocationText`), used for `find_loc=`. */
  searchLocation: string | null;
}

/** Build the public category URL for a Florida city. */
export function buildCategoryUrl(city: string, category: string, page = 1, state = "fl"): string {
  const base = `${BBB_ORIGIN}/us/${state}/${city}/category/${category}`;
  return page > 1 ? `${base}?page=${page}` : base;
}

/** Parameters of the same-origin search API. */
export interface SearchApiParams {
  /** `find_text`, e.g. `"Roofing Contractors"`. */
  text: string;
  /** `find_loc`, e.g. `"Kissimmee, FL"`. */
  location: string;
  page: number;
  /** `Relevance` (default) | `Distance` | `Rating` | `AToZ` | `ZToA`. */
  sort?: string;
  /** Sub-category id such as `10126-210` (Residential Roofing). */
  filterCategory?: string;
  country?: string;
}

/** Site-relative path for `/api/search` (must be fetched from a bbb.org page context). */
export function buildSearchApiPath(p: SearchApiParams): string {
  const q = new URLSearchParams({
    find_country: p.country ?? "USA",
    find_text: p.text,
    find_loc: p.location,
    page: String(p.page),
  });
  if (p.sort && p.sort !== "Relevance") q.set("sort", p.sort);
  if (p.filterCategory) q.set("filter_category", p.filterCategory);
  return `/api/search?${q.toString()}`;
}

function parseListingItem(item: unknown): ListingResult | null {
  const o = asObject(item);
  if (!o) return null;
  const reportUrl = asString(o.reportUrl) ?? asString(o.localReportUrl);
  if (!reportUrl) return null;
  const id = parseBbbId(reportUrl);
  if (!id) return null;
  const name = stripTags(asString(o.businessName));
  if (!name) return null;
  const categories = asArray(o.categories)
    .map((c) => asString(asObject(c)?.name))
    .filter((c): c is string => c !== null);
  return {
    ...id,
    name,
    profileUrl: canonicalProfileUrl(reportUrl),
    city: asString(o.city),
    state: asString(o.state),
    postalCode: asString(o.postalcode),
    rating: normalizeRating(asString(o.rating)),
    ratingScore: asNumber(o.ratingScore),
    accredited: asBoolean(o.bbbMember),
    phones: asArray(o.phone)
      .map((p) => asString(p))
      .filter((p): p is string => p !== null),
    categories,
    primaryCategory: stripTags(asString(o.tobText)),
    outOfBusiness: o.outOfBusinessStatus !== null && o.outOfBusinessStatus !== undefined && o.outOfBusinessStatus !== false && o.outOfBusinessStatus !== 0,
  };
}

/**
 * Parse a `searchResult` object — either `__PRELOADED_STATE__.searchResult`
 * from a category page or the body of `/api/search`.
 */
export function parseSearchResult(searchResult: unknown): CategoryListing {
  const sr = asObject(searchResult) ?? {};
  const results: ListingResult[] = [];
  const seen = new Set<string>();
  for (const item of asArray(sr.results)) {
    const r = parseListingItem(item);
    if (!r || seen.has(r.bbbId)) continue;
    seen.add(r.bbbId);
    results.push(r);
  }
  const page = asInt(sr.page);
  const totalPages = asInt(sr.totalPages);
  return {
    profileUrls: results.map((r) => r.profileUrl),
    hasNext: page !== null && totalPages !== null ? page < totalPages : false,
    page,
    totalPages,
    totalResults: asInt(sr.totalResults),
    results,
    searchText: asString(get(sr, ["heading", "searchInputText"])),
    searchLocation: asString(get(sr, ["heading", "searchLocationText"])),
  };
}

/** Markup-only fallback: profile anchors + numbered pagination links. */
function parseCategoryDom(html: string): CategoryListing {
  const $ = cheerio.load(html);
  const results: ListingResult[] = [];
  const seen = new Set<string>();
  $('a[href*="/profile/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const id = parseBbbId(href);
    if (!id || seen.has(id.bbbId)) return;
    const name = stripTags($(el).text());
    if (!name) return; // logo / image links; the name link comes later in the card
    seen.add(id.bbbId);
    results.push({
      ...id,
      name,
      profileUrl: canonicalProfileUrl(href),
      city: null,
      state: null,
      postalCode: null,
      rating: null,
      ratingScore: null,
      accredited: null,
      phones: [],
      categories: [],
      primaryCategory: null,
      outOfBusiness: false,
    });
  });
  let current = 1;
  const currentText = $("[aria-current='page']").first().attr("href") ?? "";
  const cm = /[?&]page=(\d+)/.exec(currentText);
  if (cm) current = Number(cm[1]);
  let maxLinked = current;
  $('a[href*="page="]').each((_, el) => {
    const m = /[?&]page=(\d+)/.exec($(el).attr("href") ?? "");
    if (m) maxLinked = Math.max(maxLinked, Number(m[1]));
  });
  return {
    profileUrls: results.map((r) => r.profileUrl),
    hasNext: maxLinked > current,
    page: current,
    totalPages: maxLinked > current ? maxLinked : null,
    totalResults: null,
    results,
    searchText: null,
    searchLocation: null,
  };
}

/**
 * Parse a category page's HTML. Prefers the embedded `searchResult` state and
 * falls back to anchor/pagination markup when the state is missing.
 */
export function parseCategoryPage(html: string): CategoryListing {
  const state = extractPreloadedState(html);
  const sr = asObject(get(state, ["searchResult"]));
  if (sr && Array.isArray(sr.results)) return parseSearchResult(sr);
  return parseCategoryDom(html);
}
