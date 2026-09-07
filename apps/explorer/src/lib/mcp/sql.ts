/**
 * SQL builders for the `properties` and `permits` views served by the MCP.
 *
 * Rules (enforced here, tested in `sql.test.ts`):
 * - user text is never interpolated; only finite numbers, whitelisted enum
 *   values, strictly validated identifiers (parcel ids) and escaped `ILIKE`
 *   terms make it into the statement;
 * - every statement is a single read-only `SELECT` with an explicit `LIMIT`.
 *
 * @module mcp/sql
 */
import { PERMITS_COLUMNS, PROPERTIES_COLUMNS } from "@osceola/shared";

const PROPERTY_COLUMN_SET = new Set(PROPERTIES_COLUMNS.map((c) => c.name));
const PERMIT_COLUMN_SET = new Set(PERMITS_COLUMNS.map((c) => c.name));

/** Assert a finite number and return it formatted for SQL. */
export function num(value: number, name = "value"): string {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be a finite number`);
  return String(value);
}

/** Positive integer clamp for LIMIT clauses. */
export function limitOf(value: number | undefined, fallback: number, max = 1000): number {
  const n = Math.floor(value ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** Validate a column name against the published contract for the given table. */
export function column(name: string, table: "properties" | "permits"): string {
  const ok = table === "properties" ? PROPERTY_COLUMN_SET.has(name) : PERMIT_COLUMN_SET.has(name);
  if (!ok || !/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unknown ${table} column: ${name}`);
  return name;
}

/** Quote a strictly validated identifier-like value (parcel ids, run ids, permit ids). */
export function safeId(value: string, name = "id"): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,64}$/.test(value))
    throw new Error(`${name} contains unsupported characters`);
  return `'${value}'`;
}

/** Escape a free-text term for `ILIKE '%term%' ESCAPE '\\'` (quotes, %, _ and backslash). */
export function likeTerm(term: string): string {
  const cleaned = [...term]
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join("")
    .slice(0, 120);
  const escaped = cleaned
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  return `'%${escaped}%' ESCAPE '\\'`;
}

/** DuckDB haversine expression (miles) from a row's latitude/longitude to a point. */
export function haversineSql(lat: number, lng: number): string {
  const la = num(lat, "lat");
  const ln = num(lng, "lng");
  return (
    `3958.8*2*asin(sqrt(pow(sin(radians(latitude-(${la}))/2),2)` +
    `+cos(radians(${la}))*cos(radians(latitude))*pow(sin(radians(longitude-(${ln}))/2),2)))`
  );
}

/** Cheap bounding-box pre-filter so DuckDB prunes most rows before the trig. */
function bboxSql(lat: number, lng: number, radiusMiles: number): string {
  const dLat = radiusMiles / 69.0;
  const dLng = radiusMiles / (69.0 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return (
    `latitude BETWEEN ${num(lat - dLat)} AND ${num(lat + dLat)} ` +
    `AND longitude BETWEEN ${num(lng - dLng)} AND ${num(lng + dLng)}`
  );
}

export const PROPERTY_TYPES = [
  "residential",
  "commercial",
  "industrial",
  "agricultural",
  "institutional",
  "government",
  "other",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export interface RadiusPropertiesOptions {
  lat: number;
  lng: number;
  radiusMiles: number;
  /** Minimum roof age in years (inclusive). `null` disables the filter. */
  minRoofAgeYears?: number | null;
  /** Only properties with at least one open roofing permit. */
  openRoofPermits?: boolean;
  /** Only properties whose oldest open roofing permit is older than this many years. */
  openRoofPermitMinYears?: number | null;
  /** Owner mails outside Florida. */
  ownerOutOfState?: boolean;
  /** No sale recorded in at least this many years. */
  minYearsSinceSale?: number | null;
  /** Restrict to these property types (validated against the enum). */
  propertyTypes?: readonly PropertyType[];
  /** Owner name ILIKE filter (escaped). */
  ownerContains?: string | null;
  /** Restrict to these parcels (validated ids; used when a permit-side filter picked the parcels first). */
  parcelIdentifiers?: readonly string[];
  limit?: number;
}

/** Columns returned by the lead queries (subset of the contract, kept small for the map). */
export const LEAD_PROPERTY_COLUMNS = [
  "property_id",
  "parcel_identifier",
  "address_street",
  "address_city",
  "address_zip",
  "latitude",
  "longitude",
  "property_type",
  "property_usage_type",
  "built_year",
  "effective_year",
  "roof_age_years",
  "roof_age_basis",
  "last_roof_permit_date",
  "open_roof_permit_count",
  "oldest_open_roof_permit_days",
  "permit_count",
  "has_bbb_contractor",
  "owner_name",
  "owners_text",
  "owner_occupied",
  "owner_mail_city",
  "owner_mail_state",
  "owner_out_of_state",
  "owner_out_of_county",
  "last_sale_date",
  "last_sale_price",
  "years_since_sale",
  "market_value",
  "livable_floor_area",
  "source_urls",
  "last_changed_run_id",
] as const;

/**
 * Properties within a radius that match the roofing-lead filters, oldest roof first (then nearest).
 * Always uses a bbox pre-filter plus the exact haversine distance.
 */
export function buildRadiusPropertiesSql(o: RadiusPropertiesOptions): string {
  if (o.radiusMiles <= 0 || o.radiusMiles > 50) throw new Error("radiusMiles must be in (0, 50]");
  const cols = LEAD_PROPERTY_COLUMNS.map((c) => column(c, "properties")).join(", ");
  const where: string[] = [
    "latitude IS NOT NULL",
    "longitude IS NOT NULL",
    bboxSql(o.lat, o.lng, o.radiusMiles),
  ];
  if (o.minRoofAgeYears != null)
    where.push(`roof_age_years >= ${num(o.minRoofAgeYears, "minRoofAgeYears")}`);
  if (o.openRoofPermits) where.push("open_roof_permit_count > 0");
  if (o.openRoofPermitMinYears != null)
    where.push(
      `oldest_open_roof_permit_days >= ${num(Math.round(o.openRoofPermitMinYears * 365.25), "openRoofPermitMinYears")}`,
    );
  if (o.ownerOutOfState) where.push("owner_out_of_state = true");
  if (o.minYearsSinceSale != null)
    where.push(`years_since_sale >= ${num(o.minYearsSinceSale, "minYearsSinceSale")}`);
  if (o.propertyTypes && o.propertyTypes.length > 0) {
    const types = o.propertyTypes.map((t) => {
      if (!PROPERTY_TYPES.includes(t)) throw new Error(`unknown property type: ${String(t)}`);
      return `'${t}'`;
    });
    where.push(`property_type IN (${types.join(", ")})`);
  }
  if (o.ownerContains && o.ownerContains.trim())
    where.push(`owners_text ILIKE ${likeTerm(o.ownerContains.trim())}`);
  if (o.parcelIdentifiers) {
    if (o.parcelIdentifiers.length === 0 || o.parcelIdentifiers.length > 1000)
      throw new Error("parcelIdentifiers must hold 1..1000 ids");
    where.push(
      `parcel_identifier IN (${o.parcelIdentifiers.map((p) => safeId(p, "parcel_identifier")).join(", ")})`,
    );
  }
  return (
    `SELECT * FROM (SELECT ${cols}, round(${haversineSql(o.lat, o.lng)}, 2) AS distance_miles ` +
    `FROM properties WHERE ${where.join(" AND ")}) ` +
    `WHERE distance_miles <= ${num(o.radiusMiles, "radiusMiles")} ` +
    `ORDER BY roof_age_years DESC NULLS LAST, distance_miles ASC LIMIT ${limitOf(o.limit, 500)}`
  );
}

/** Same filters as {@link buildRadiusPropertiesSql} but returns only the total match count (no LIMIT bias). */
export function buildRadiusPropertiesCountSql(o: Omit<RadiusPropertiesOptions, "limit">): string {
  const inner = buildRadiusPropertiesSql({ ...o, limit: 1 });
  // Reuse the exact WHERE clause of the list query so count and list can never drift apart.
  const from = inner.indexOf("FROM properties WHERE ");
  const end = inner.indexOf(") WHERE distance_miles <=");
  const whereClause = inner.slice(from + "FROM properties WHERE ".length, end);
  return `SELECT count(*) AS total FROM properties WHERE ${whereClause} AND ${haversineSql(o.lat, o.lng)} <= ${num(o.radiusMiles, "radiusMiles")}`;
}

export interface RadiusPermitsOptions {
  lat: number;
  lng: number;
  radiusMiles: number;
  /** Only roofing permits (default true). */
  roofingOnly?: boolean;
  /** Only open permits (default true). */
  openOnly?: boolean;
  /** Minimum days open. */
  minDaysOpen?: number | null;
  /** Restrict to permits with a contractor name. */
  requireContractor?: boolean;
  limit?: number;
}

export const LEAD_PERMIT_COLUMNS = [
  "property_improvement_id",
  "property_id",
  "parcel_identifier",
  "permit_number",
  "improvement_type",
  "improvement_status",
  "improvement_action",
  "permit_issue_date",
  "opened_date",
  "permit_close_date",
  "final_inspection_date",
  "completion_date",
  "expiration_date",
  "is_roofing",
  "is_open",
  "days_open",
  "issuing_agency",
  "description",
  "estimated_job_value",
  "contractor_name",
  "contractor_qualifier",
  "contractor_phone",
  "contractor_license",
  "contractor_id",
  "bbb_rating",
  "bbb_accredited",
  "bbb_profile_url",
  "bbb_match_method",
  "latitude",
  "longitude",
  "address_street",
  "address_city",
  "address_zip",
  "source_system",
  "source_url",
  "fetched_at",
] as const;

/** Open roofing permits within a radius, longest-open first. */
export function buildRadiusPermitsSql(o: RadiusPermitsOptions): string {
  if (o.radiusMiles <= 0 || o.radiusMiles > 50) throw new Error("radiusMiles must be in (0, 50]");
  const cols = LEAD_PERMIT_COLUMNS.map((c) => column(c, "permits")).join(", ");
  const where: string[] = [
    "latitude IS NOT NULL",
    "longitude IS NOT NULL",
    bboxSql(o.lat, o.lng, o.radiusMiles),
  ];
  if (o.roofingOnly ?? true) where.push("is_roofing = true");
  if (o.openOnly ?? true) where.push("is_open = true");
  if (o.minDaysOpen != null)
    where.push(`days_open >= ${num(Math.floor(o.minDaysOpen), "minDaysOpen")}`);
  if (o.requireContractor) where.push("contractor_name IS NOT NULL");
  return (
    `SELECT * FROM (SELECT ${cols}, round(${haversineSql(o.lat, o.lng)}, 2) AS distance_miles ` +
    `FROM permits WHERE ${where.join(" AND ")}) ` +
    `WHERE distance_miles <= ${num(o.radiusMiles, "radiusMiles")} ` +
    `ORDER BY days_open DESC NULLS LAST, distance_miles ASC LIMIT ${limitOf(o.limit, 200)}`
  );
}

/** One property by parcel identifier (all contract columns). */
export function buildPropertyByParcelSql(parcelIdentifier: string): string {
  return `SELECT * FROM properties WHERE parcel_identifier = ${safeId(parcelIdentifier, "parcel_identifier")} LIMIT 1`;
}

/** All permits on a parcel, roofing and open first, newest first. */
export function buildPermitsByParcelSql(parcelIdentifier: string, limit = 200): string {
  const cols = LEAD_PERMIT_COLUMNS.map((c) => column(c, "permits")).join(", ");
  return (
    `SELECT ${cols} FROM permits WHERE parcel_identifier = ${safeId(parcelIdentifier, "parcel_identifier")} ` +
    `ORDER BY is_roofing DESC, is_open DESC, coalesce(permit_issue_date, opened_date) DESC NULLS LAST LIMIT ${limitOf(limit, 200)}`
  );
}

/** Permits for a list of parcels (used to enrich a radius result set in one round trip). */
export function buildPermitsForParcelsSql(
  parcelIdentifiers: readonly string[],
  opts: { roofingOnly?: boolean; openOnly?: boolean; limit?: number } = {},
): string {
  if (parcelIdentifiers.length === 0) throw new Error("parcelIdentifiers must not be empty");
  if (parcelIdentifiers.length > 500) throw new Error("at most 500 parcels per query");
  const cols = LEAD_PERMIT_COLUMNS.map((c) => column(c, "permits")).join(", ");
  const ids = parcelIdentifiers.map((p) => safeId(p, "parcel_identifier")).join(", ");
  const where = [`parcel_identifier IN (${ids})`];
  if (opts.roofingOnly ?? true) where.push("is_roofing = true");
  if (opts.openOnly ?? false) where.push("is_open = true");
  return `SELECT ${cols} FROM permits WHERE ${where.join(" AND ")} ORDER BY days_open DESC NULLS LAST LIMIT ${limitOf(opts.limit, 1000)}`;
}

/**
 * Cheap pre-check before a console/agent statement is sent to the MCP: a single
 * statement starting with SELECT or WITH. The MCP's own validator remains the
 * authority (it also rejects mutating and file/extension keywords).
 */
export function assertReadOnlySelect(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (trimmed.length === 0) throw new Error("empty statement");
  if (trimmed.length > 20_000) throw new Error("statement too long");
  if (!/^(select|with)\b/i.test(trimmed))
    throw new Error("only a single SELECT (or WITH … SELECT) statement is allowed");
  if (/;/.test(trimmed)) throw new Error("multiple statements are not allowed");
  return trimmed;
}
