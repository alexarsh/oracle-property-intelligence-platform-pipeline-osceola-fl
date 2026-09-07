/**
 * Normalisers for the BBB harvester: business ids, phones, license numbers,
 * letter ratings and the `<em>` highlight markup the search API leaves in names.
 *
 * @module sources/bbb/normalize
 */

/** Public origin every relative BBB link is resolved against. */
export const BBB_ORIGIN = "https://www.bbb.org";

/**
 * Parts of a BBB business id. BBB identifies a business by the bureau that
 * owns the file (`0733` = BBB Serving Central Florida) plus a per-bureau
 * business number; both appear as the trailing `-<bureau>-<business>` segment
 * of every profile URL.
 */
export interface BbbIdParts {
  /** `"0733-90573947"` — the id the rest of the pipeline keys on. */
  bbbId: string;
  /** `"0733"` */
  bureauId: string;
  /** `"90573947"` */
  businessId: string;
}

const PROFILE_SEGMENT = /\/profile\/[^/?#]+\/([^/?#]+)/;
const ID_SUFFIX = /-(\d{3,4})-(\d{4,})$/;

/**
 * Extract the BBB business id from a profile URL (absolute or site-relative).
 * Works for `.../profile/<category>/<slug>-0733-90573947`, the
 * `/addressId/<n>` location variants and sub-pages such as
 * `.../-0733-90573947/customer-reviews`. Returns `null` when the URL is not a
 * profile URL.
 */
export function parseBbbId(url: string): BbbIdParts | null {
  const seg = PROFILE_SEGMENT.exec(url)?.[1];
  if (!seg) return null;
  const m = ID_SUFFIX.exec(seg);
  if (!m) return null;
  const bureauId = m[1]!;
  const businessId = m[2]!;
  return { bbbId: `${bureauId}-${businessId}`, bureauId, businessId };
}

/** `parseBbbId(url)?.bbbId ?? null` */
export function bbbIdFromUrl(url: string): string | null {
  return parseBbbId(url)?.bbbId ?? null;
}

/**
 * Canonical absolute profile URL: resolved against {@link BBB_ORIGIN}, query
 * string and fragment removed, trailing slash trimmed. The `/addressId/<n>`
 * location suffix is kept — it is part of what BBB served and it selects the
 * address shown on multi-location profiles.
 */
export function canonicalProfileUrl(url: string): string {
  const u = new URL(url, BBB_ORIGIN);
  u.search = "";
  u.hash = "";
  const href = u.href;
  return href.endsWith("/") ? href.slice(0, -1) : href;
}

/**
 * Normalise a phone number to ten digits (kit tier-2 matching rule: strip
 * punctuation and a leading `+1`). Anything that is not a North American
 * 10-digit number after cleanup yields `null`.
 */
export function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  let digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

/**
 * Normalise a license number: uppercase, drop a leading `#`/`No.`/`License`
 * label and every space, hyphen or dot inside the code (`CCC 1330-217` →
 * `CCC1330217`). Returns `null` for values that do not look like a license
 * code (must contain a digit, 4–20 alphanumerics).
 */
export function normalizeLicense(value: string | null | undefined): string | null {
  if (!value) return null;
  let s = value.toUpperCase().trim();
  s = s.replace(/^(?:LICENSE|LIC|NO|NUMBER|#|\.|:|\s)+/g, "");
  s = s.replace(/[\s\-.#/]/g, "");
  if (!/^[A-Z0-9]{4,20}$/.test(s) || !/\d/.test(s)) return null;
  return s;
}

/**
 * Florida DBPR / Construction Industry Licensing Board number shapes as they
 * appear in free text: a 2–4 letter prefix (`CCC`, `CGC`, `CBC`, `CRC`, `CAC`,
 * `EC`, `RC`, `SCC`, …) followed by 5–8 digits, with optional separators.
 */
const LICENSE_IN_TEXT = /\b([A-Z]{2,4})\s?[-.]?\s?(\d{5,8})\b/g;

/**
 * Pull license numbers out of free text (BBB "Licensing" notes). Returns
 * normalised, de-duplicated codes in order of first appearance.
 */
export function extractLicenseNumbers(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.toUpperCase().matchAll(LICENSE_IN_TEXT)) {
    const code = normalizeLicense(`${m[1]}${m[2]}`);
    if (code) out.add(code);
  }
  return [...out];
}

/** Merge license lists: normalise, drop nulls, de-duplicate, keep order. */
export function mergeLicenseNumbers(...lists: (readonly (string | null | undefined)[])[]): string[] {
  const out = new Set<string>();
  for (const list of lists) for (const v of list) {
    const code = normalizeLicense(v);
    if (code) out.add(code);
  }
  return [...out];
}

const LETTER_RATING = /^(A\+|A|A-|B\+|B|B-|C\+|C|C-|D\+|D|D-|F)$/;

/**
 * BBB letter rating (`A+` … `F`) or `null` for `NR` / "Not Rated" / anything
 * else. BBB's own rating vocabulary is exactly these 13 grades.
 */
export function normalizeRating(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toUpperCase().replace(/\s+/g, "");
  return LETTER_RATING.test(v) ? v : null;
}

/** Strip tags (the search API wraps matched words in `<em>`) and collapse whitespace. */
export function stripTags(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = value
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 0 ? t : null;
}

/** `"saint-cloud"` → `"Saint Cloud"`; used to derive search text from URL slugs. */
export function slugToTitle(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
