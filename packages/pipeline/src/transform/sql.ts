/**
 * SQL fragments shared by the transform steps. Kept as small, documented
 * helpers so the table builders read top-down.
 * @module transform/sql
 */

/**
 * `'YYYY-MM-DD HH:MM:SS.mmm'` (OCPA) or ISO date -> DATE. NULL when blank or
 * invalid, and NULL for the placeholder dates the source uses instead of NULL
 * (`1899-12-30`, `1900-01-01` and anything before 1900).
 */
export const ocpaDate = (col: string): string =>
  `CASE WHEN TRY_CAST(substr(NULLIF(trim(${col}), ''), 1, 10) AS DATE) > DATE '1900-01-01'
        THEN TRY_CAST(substr(trim(${col}), 1, 10) AS DATE) END`;

/** Numeric text -> DOUBLE, NULL when blank. */
export const num = (col: string): string => `TRY_CAST(NULLIF(trim(${col}), '') AS DOUBLE)`;

/** Integer year text -> BIGINT within a sane range, else NULL. */
export const year = (col: string): string =>
  `CASE WHEN TRY_CAST(NULLIF(trim(${col}), '') AS INTEGER) BETWEEN 1700 AND year(current_date) + 1
        THEN TRY_CAST(trim(${col}) AS BIGINT) END`;

/** Trimmed text -> NULL when blank. */
export const txt = (col: string): string => `NULLIF(trim(${col}), '')`;

/** Parcel key normalization: the 18-character STRAP with separators removed, upper-cased. */
export const parcelKey = (col: string): string =>
  `upper(regexp_replace(coalesce(${col}, ''), '[^A-Za-z0-9]', '', 'g'))`;

/** Phone -> 10 digits (drops a leading country code 1), NULL otherwise. */
export const phone10 = (col: string): string =>
  `CASE WHEN length(regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g')) = 10
          THEN regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g')
        WHEN length(regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g')) = 11
         AND left(regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g'), 1) = '1'
          THEN right(regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g'), 10) END`;

/**
 * Roofing classifier. Type codes RR/RF are re-roof/roofing in the OCPA export;
 * otherwise the description must mention roofing and must not be a screen room,
 * enclosure, solar array or similar structure that merely sits on a roof.
 */
export const isRoofing = (typeCol: string, descCol: string): string => `(
  upper(trim(coalesce(${typeCol}, ''))) IN ('RR', 'RF', 'ROOF', 'REROOF', 'RE-ROOF', 'ROOFING')
  OR lower(coalesce(${typeCol}, '')) LIKE '%roof%'
  OR (
    regexp_matches(lower(coalesce(${descCol}, '')), '(re-?\\s?roof|\\broof(ing)?\\b|shingle|tile roof|metal roof)')
    AND NOT regexp_matches(lower(coalesce(${descCol}, '')), '(screen|enclosure|lanai|pergola|carport|solar|\\bpv\\b|roof[- ]?mount|antenna|awning|\\bsign\\b|hvac|a/c|rooftop unit|\\brtu\\b)')
  ))`;

/** Corporate-suffix stripping for contractor name matching (tier 3 of the kit's cascade). */
export const normalizedName = (col: string): string => `nullif(trim(regexp_replace(regexp_replace(
  regexp_replace(upper(coalesce(${col}, '')), '[^A-Z0-9 ]', ' ', 'g'),
  '\\b(LLC|L L C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LP|PLLC|PA|SERVICES?|CONSTRUCTION|CONTRACTORS?|CONTRACTING|ROOFING|ENTERPRISES?|GROUP|OF FLORIDA|FL|FLORIDA|THE|AND)\\b', ' ', 'g'),
  ' +', ' ', 'g')), '')`;

/**
 * OCPA records contractors as `LAST, FIRST - BUSINESS NAME` (license holder,
 * then the company). Returns the business part when present, else the whole
 * value; `contractorQualifier` returns the person part.
 */
export const contractorBusiness = (col: string): string =>
  `CASE WHEN position(' - ' IN coalesce(${col}, '')) > 0
        THEN nullif(trim(substr(${col}, position(' - ' IN ${col}) + 3)), '')
        ELSE nullif(trim(${col}), '') END`;
export const contractorQualifier = (col: string): string =>
  `CASE WHEN position(' - ' IN coalesce(${col}, '')) > 0 THEN nullif(trim(substr(${col}, 1, position(' - ' IN ${col}) - 1)), '') END`;

/** sha256 hex of a concatenation of columns (change detection). */
export const rowHash = (cols: readonly string[]): string =>
  `sha256(concat_ws('|', ${cols.map((c) => `coalesce(CAST(${c} AS VARCHAR), '')`).join(", ")}))`;
