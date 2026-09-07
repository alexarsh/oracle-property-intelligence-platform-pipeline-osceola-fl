/**
 * Small, pure normalisation helpers shared by the list and detail parsers.
 *
 * @module sources/accela/normalize
 */

/**
 * Collapse whitespace (including `&nbsp;` already decoded to U+00A0) and trim;
 * returns null for empty input so callers can store "absent" uniformly.
 */
export function cleanText(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.replace(/[\s\u00a0]+/g, " ").trim();
  return s.length > 0 ? s : null;
}

/**
 * Normalise a parcel number for joining against the appraiser / GIS layers:
 * separators, spaces and punctuation are removed and letters upper-cased.
 *
 * Letters are deliberately kept: Osceola parcel identifiers can carry an
 * alphabetic lot/block character (e.g. `3125290000015A0000` seen on the
 * portal), and dropping it would merge distinct parcels. Returns null when
 * nothing alphanumeric remains.
 */
export function normalizeParcelNumber(raw: string | null): string | null {
  if (raw == null) return null;
  const s = raw.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return s.length > 0 ? s : null;
}

/**
 * Reduce a phone string to its 10 NANP digits (a leading country code `1` is
 * stripped). Anything that does not end up as exactly 10 digits yields null.
 */
export function normalizePhone(raw: string | null): string | null {
  if (raw == null) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

/**
 * Convert the portal's `MM/DD/YYYY` (optionally followed by a time) to ISO
 * `YYYY-MM-DD`; null for anything else.
 */
export function toIsoDate(raw: string | null | undefined): string | null {
  const s = cleanText(raw);
  if (s == null) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
}

/** Convert ISO `YYYY-MM-DD` to the `MM/DD/YYYY` the search form expects. */
export function toPortalDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`expected YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/** Parse `$12,500.00` / `12500` style money strings; null when not numeric. */
export function parseMoney(raw: string | null | undefined): number | null {
  const s = cleanText(raw);
  if (s == null) return null;
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Strip a trailing colon and surrounding whitespace from a form label. */
export function labelKey(raw: string | null | undefined): string | null {
  const s = cleanText(raw);
  return s == null ? null : s.replace(/\s*:\s*$/, "");
}
