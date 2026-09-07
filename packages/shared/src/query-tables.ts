/**
 * Published query-table contracts.
 *
 * `properties` keeps the exact column set the soofi-xyz kit's query table uses
 * (so the stock `@elephant-xyz/mcp` `queryProperties` / `findPropertiesInArea`
 * tools serve it unchanged) and appends roofing-lead columns. `permits` follows
 * the kit permit table and appends contractor / BBB / geometry columns so a single
 * SQL statement can answer "long-open roofing permits near a point with contractor
 * and rating".
 *
 * @module query-tables
 */

export interface ColumnSpec {
  readonly name: string;
  /** DuckDB type. */
  readonly type: string;
  readonly description: string;
  /** True for columns that exist only for kit-schema stability. */
  readonly kit: boolean;
}

export const PROPERTIES_COLUMNS: readonly ColumnSpec[] = [
  {
    name: "property_id",
    type: "VARCHAR",
    kit: true,
    description: "Stable property id: sha256('osceola:' || strap), first 32 hex chars.",
  },
  {
    name: "property_cid",
    type: "VARCHAR",
    kit: true,
    description: "IPFS CID of the per-property JSON when published (NULL in this milestone).",
  },
  {
    name: "request_identifier",
    type: "VARCHAR",
    kit: true,
    description: "Appraiser STRAP (18-char folio) — the folio-level dedup key.",
  },
  {
    name: "parcel_identifier",
    type: "VARCHAR",
    kit: true,
    description: "Normalized parcel number (digits only) shared with GIS and permit portals.",
  },
  { name: "source_system", type: "VARCHAR", kit: true, description: "'osceola_appraiser'." },
  { name: "county_name", type: "VARCHAR", kit: true, description: "'Osceola'." },
  { name: "state_code", type: "VARCHAR", kit: true, description: "'FL'." },
  { name: "address_street", type: "VARCHAR", kit: true, description: "Situs street line." },
  { name: "address_city", type: "VARCHAR", kit: true, description: "Situs city." },
  { name: "address_zip", type: "VARCHAR", kit: true, description: "Situs ZIP." },
  {
    name: "latitude",
    type: "DOUBLE",
    kit: true,
    description: "Parcel centroid latitude (WGS84) from county GIS.",
  },
  {
    name: "longitude",
    type: "DOUBLE",
    kit: true,
    description: "Parcel centroid longitude (WGS84) from county GIS.",
  },
  { name: "lot_size_acre", type: "DOUBLE", kit: true, description: "Lot size in acres." },
  { name: "lot_area_sqft", type: "DOUBLE", kit: true, description: "Lot area in square feet." },
  {
    name: "exterior_wall_material",
    type: "VARCHAR",
    kit: true,
    description: "Not available for Osceola (NULL).",
  },
  {
    name: "roof_covering_material",
    type: "VARCHAR",
    kit: true,
    description: "Not available for Osceola (NULL).",
  },
  {
    name: "property_type",
    type: "VARCHAR",
    kit: true,
    description: "Coarse class from DOR use code (residential / commercial / …).",
  },
  {
    name: "property_usage_type",
    type: "VARCHAR",
    kit: true,
    description: "DOR land-use description.",
  },
  {
    name: "built_year",
    type: "BIGINT",
    kit: true,
    description: "Actual year built of the primary building.",
  },
  { name: "livable_floor_area", type: "DOUBLE", kit: true, description: "Heated area (sq ft)." },
  { name: "total_area", type: "DOUBLE", kit: true, description: "Gross building area (sq ft)." },
  { name: "assessed_value", type: "DOUBLE", kit: true, description: "Assessed value." },
  { name: "market_value", type: "DOUBLE", kit: true, description: "Just (market) value." },
  { name: "land_value", type: "DOUBLE", kit: true, description: "Land value." },
  { name: "avm_value", type: "DOUBLE", kit: true, description: "NULL (no AVM source)." },
  { name: "owner_name", type: "VARCHAR", kit: true, description: "Primary owner." },
  { name: "owners_text", type: "VARCHAR", kit: true, description: "All owners, ' | ' separated." },
  { name: "owner_count", type: "BIGINT", kit: true, description: "Number of owners." },
  {
    name: "owner_occupied",
    type: "BOOLEAN",
    kit: true,
    description: "Mailing address matches situs (homestead proxy).",
  },
  {
    name: "last_sale_date",
    type: "VARCHAR",
    kit: true,
    description: "Most recent sale date (ISO).",
  },
  { name: "last_sale_price", type: "DOUBLE", kit: true, description: "Most recent sale price." },
  { name: "subdivision", type: "VARCHAR", kit: true, description: "Subdivision name." },
  { name: "has_permits", type: "BOOLEAN", kit: true, description: "Any permit known." },
  {
    name: "permit_count",
    type: "BIGINT",
    kit: true,
    description: "Known permit count (all sources, deduplicated).",
  },
  {
    name: "has_sunbiz_tenant",
    type: "BOOLEAN",
    kit: true,
    description: "NULL (Sunbiz not in this milestone).",
  },
  {
    name: "has_bbb_contractor",
    type: "BOOLEAN",
    kit: true,
    description: "A permit on this parcel has a BBB-rated contractor.",
  },
  { name: "has_pa_corp_tenant", type: "BOOLEAN", kit: true, description: "NULL." },
  { name: "hoa_flag", type: "BOOLEAN", kit: true, description: "NULL (reserved by the kit)." },
  // ---- roofing-lead extensions -------------------------------------------------
  {
    name: "effective_year",
    type: "BIGINT",
    kit: false,
    description: "Appraiser effective year (renovation proxy).",
  },
  {
    name: "last_roof_permit_date",
    type: "VARCHAR",
    kit: false,
    description: "Latest roofing permit issue/final date (ISO).",
  },
  {
    name: "roof_age_basis",
    type: "VARCHAR",
    kit: false,
    description: "'roof_permit' | 'built_year' | 'unknown' — what roof_age_years is derived from.",
  },
  {
    name: "roof_age_years",
    type: "INTEGER",
    kit: false,
    description: "Years since roof_age_basis date, as of the run date.",
  },
  {
    name: "open_roof_permit_count",
    type: "INTEGER",
    kit: false,
    description: "Roofing permits with no final/close date.",
  },
  {
    name: "oldest_open_roof_permit_days",
    type: "INTEGER",
    kit: false,
    description: "Days the oldest open roofing permit has been open.",
  },
  {
    name: "years_since_sale",
    type: "DOUBLE",
    kit: false,
    description: "Years since last_sale_date.",
  },
  { name: "owner_mail_city", type: "VARCHAR", kit: false, description: "Owner mailing city." },
  {
    name: "owner_mail_state",
    type: "VARCHAR",
    kit: false,
    description: "Owner mailing state / province.",
  },
  {
    name: "owner_mail_country",
    type: "VARCHAR",
    kit: false,
    description: "Owner mailing country code.",
  },
  {
    name: "owner_out_of_county",
    type: "BOOLEAN",
    kit: false,
    description: "Owner mails outside Osceola County ZIPs.",
  },
  {
    name: "owner_out_of_state",
    type: "BOOLEAN",
    kit: false,
    description: "Owner mails outside Florida.",
  },
  {
    name: "gis_year_built",
    type: "BIGINT",
    kit: false,
    description: "Year built as carried by the GIS layer (cross-check).",
  },
  {
    name: "source_urls",
    type: "VARCHAR",
    kit: false,
    description: "' | '-separated canonical source URLs backing this row.",
  },
  {
    name: "first_seen_run_id",
    type: "VARCHAR",
    kit: false,
    description: "Run that first produced this row.",
  },
  {
    name: "last_changed_run_id",
    type: "VARCHAR",
    kit: false,
    description: "Run that last changed any column of this row.",
  },
  {
    name: "row_hash",
    type: "VARCHAR",
    kit: false,
    description: "sha256 of the business columns (change detection).",
  },
];

export const PERMITS_COLUMNS: readonly ColumnSpec[] = [
  {
    name: "property_improvement_id",
    type: "VARCHAR",
    kit: true,
    description: "Stable permit id: sha256(source_system || permit_number).",
  },
  {
    name: "property_id",
    type: "VARCHAR",
    kit: true,
    description: "Matched property id (NULL if unmatched).",
  },
  {
    name: "parcel_identifier",
    type: "VARCHAR",
    kit: true,
    description: "Normalized parcel number.",
  },
  { name: "permit_number", type: "VARCHAR", kit: true, description: "Permit number as issued." },
  {
    name: "improvement_type",
    type: "VARCHAR",
    kit: true,
    description: "Normalized category (Roofing, Screen enclosure, …).",
  },
  {
    name: "improvement_status",
    type: "VARCHAR",
    kit: true,
    description: "Normalized status (open / finaled / expired / voided / unknown).",
  },
  {
    name: "improvement_action",
    type: "VARCHAR",
    kit: true,
    description: "Source permit type code / record type label.",
  },
  { name: "permit_issue_date", type: "VARCHAR", kit: true, description: "ISO date." },
  { name: "application_received_date", type: "VARCHAR", kit: true, description: "ISO date." },
  { name: "final_inspection_date", type: "VARCHAR", kit: true, description: "ISO date." },
  { name: "permit_close_date", type: "VARCHAR", kit: true, description: "ISO date." },
  { name: "completion_date", type: "VARCHAR", kit: true, description: "ISO date (CO / sign-off)." },
  { name: "expiration_date", type: "VARCHAR", kit: true, description: "ISO date." },
  {
    name: "opened_date",
    type: "VARCHAR",
    kit: true,
    description: "ISO date the record was opened.",
  },
  {
    name: "source_system",
    type: "VARCHAR",
    kit: true,
    description: "'osceola_appraiser' | 'osceola_accela'.",
  },
  { name: "county_name", type: "VARCHAR", kit: true, description: "'Osceola'." },
  { name: "project_description", type: "VARCHAR", kit: true, description: "Free text." },
  { name: "description", type: "VARCHAR", kit: true, description: "Free text." },
  { name: "estimated_job_value", type: "DOUBLE", kit: true, description: "Estimated job value." },
  { name: "fee", type: "DOUBLE", kit: true, description: "NULL for Osceola sources." },
  // ---- roofing-lead extensions -------------------------------------------------
  {
    name: "is_roofing",
    type: "BOOLEAN",
    kit: false,
    description: "Classified as a roofing permit (type code or description).",
  },
  {
    name: "is_open",
    type: "BOOLEAN",
    kit: false,
    description: "No final/close/CO date and not voided/expired.",
  },
  {
    name: "days_open",
    type: "INTEGER",
    kit: false,
    description: "Days from issue (or open) date to close date, or to the run date while open.",
  },
  {
    name: "issuing_agency",
    type: "VARCHAR",
    kit: false,
    description: "'Osceola County' | 'City of Kissimmee' | 'City of St. Cloud' | NULL.",
  },
  {
    name: "contractor_name",
    type: "VARCHAR",
    kit: false,
    description: "Contractor / licensed professional as recorded.",
  },
  {
    name: "contractor_qualifier",
    type: "VARCHAR",
    kit: false,
    description:
      "Individual license holder named on the permit (appraiser feed records 'LAST, FIRST - BUSINESS').",
  },
  {
    name: "contractor_phone",
    type: "VARCHAR",
    kit: false,
    description: "Normalized 10-digit phone.",
  },
  {
    name: "contractor_license",
    type: "VARCHAR",
    kit: false,
    description: "State license number when captured.",
  },
  {
    name: "contractor_id",
    type: "VARCHAR",
    kit: false,
    description: "Reconciled contractor entity id (see contractors table).",
  },
  {
    name: "bbb_rating",
    type: "VARCHAR",
    kit: false,
    description: "BBB letter rating when matched (A+ … F).",
  },
  {
    name: "bbb_accredited",
    type: "BOOLEAN",
    kit: false,
    description: "BBB accreditation when matched.",
  },
  {
    name: "bbb_profile_url",
    type: "VARCHAR",
    kit: false,
    description: "BBB profile URL when matched.",
  },
  {
    name: "bbb_match_method",
    type: "VARCHAR",
    kit: false,
    description: "'license' | 'phone' | 'name' | NULL.",
  },
  {
    name: "latitude",
    type: "DOUBLE",
    kit: false,
    description: "Matched parcel centroid latitude.",
  },
  {
    name: "longitude",
    type: "DOUBLE",
    kit: false,
    description: "Matched parcel centroid longitude.",
  },
  { name: "address_street", type: "VARCHAR", kit: false, description: "Job site street." },
  { name: "address_city", type: "VARCHAR", kit: false, description: "Job site city." },
  { name: "address_zip", type: "VARCHAR", kit: false, description: "Job site ZIP." },
  {
    name: "source_url",
    type: "VARCHAR",
    kit: false,
    description: "Canonical source URL for this permit (portal detail page or export).",
  },
  {
    name: "fetched_at",
    type: "VARCHAR",
    kit: false,
    description: "ISO timestamp the source record was captured.",
  },
  {
    name: "first_seen_run_id",
    type: "VARCHAR",
    kit: false,
    description: "Run that first produced this row.",
  },
  {
    name: "last_changed_run_id",
    type: "VARCHAR",
    kit: false,
    description: "Run that last changed this row.",
  },
  { name: "row_hash", type: "VARCHAR", kit: false, description: "sha256 of the business columns." },
];

export const CONTRACTORS_COLUMNS: readonly ColumnSpec[] = [
  {
    name: "contractor_id",
    type: "VARCHAR",
    kit: false,
    description: "sha256 of the best identity key (license > phone > normalized name).",
  },
  { name: "display_name", type: "VARCHAR", kit: false, description: "Most frequent name variant." },
  {
    name: "normalized_name",
    type: "VARCHAR",
    kit: false,
    description: "Upper-cased name with corporate suffixes stripped.",
  },
  { name: "license_number", type: "VARCHAR", kit: false, description: "State license when known." },
  { name: "phone", type: "VARCHAR", kit: false, description: "10-digit phone when known." },
  {
    name: "identity_basis",
    type: "VARCHAR",
    kit: false,
    description: "'license' | 'phone' | 'name'.",
  },
  { name: "permit_count", type: "INTEGER", kit: false, description: "Permits across all sources." },
  { name: "roofing_permit_count", type: "INTEGER", kit: false, description: "Roofing permits." },
  {
    name: "open_roofing_permit_count",
    type: "INTEGER",
    kit: false,
    description: "Roofing permits still open.",
  },
  { name: "first_permit_date", type: "VARCHAR", kit: false, description: "ISO date." },
  { name: "last_permit_date", type: "VARCHAR", kit: false, description: "ISO date." },
  { name: "bbb_id", type: "VARCHAR", kit: false, description: "Matched BBB business id." },
  { name: "bbb_rating", type: "VARCHAR", kit: false, description: "Letter rating." },
  { name: "bbb_accredited", type: "BOOLEAN", kit: false, description: "Accreditation flag." },
  { name: "bbb_review_count", type: "INTEGER", kit: false, description: "Customer review count." },
  { name: "bbb_complaint_count", type: "INTEGER", kit: false, description: "Complaint count." },
  { name: "bbb_profile_url", type: "VARCHAR", kit: false, description: "Profile URL." },
  {
    name: "bbb_match_method",
    type: "VARCHAR",
    kit: false,
    description: "'license' | 'phone' | 'name' | NULL.",
  },
  {
    name: "source_systems",
    type: "VARCHAR",
    kit: false,
    description: "' | '-separated source systems contributing to this entity.",
  },
];

export const PLACES_COLUMNS: readonly ColumnSpec[] = [
  {
    name: "place_id",
    type: "VARCHAR",
    kit: false,
    description: "Overture GERS id (stable across releases).",
  },
  { name: "name", type: "VARCHAR", kit: false, description: "Primary business / place name." },
  {
    name: "taxonomy_primary",
    type: "VARCHAR",
    kit: false,
    description: "Most specific Overture taxonomy label.",
  },
  {
    name: "taxonomy_hierarchy",
    type: "VARCHAR",
    kit: false,
    description: "'/'-joined L0..primary taxonomy path (canonical roll-up field).",
  },
  { name: "basic_category", type: "VARCHAR", kit: false, description: "Coarse Overture category." },
  {
    name: "is_contractor",
    type: "BOOLEAN",
    kit: false,
    description: "Taxonomy path names a construction / roofing / home-improvement contractor.",
  },
  {
    name: "operating_status",
    type: "VARCHAR",
    kit: false,
    description: "open / closed / … as published by Overture.",
  },
  {
    name: "confidence",
    type: "DOUBLE",
    kit: false,
    description: "Overture existence confidence (0..1).",
  },
  {
    name: "phone",
    type: "VARCHAR",
    kit: false,
    description: "Normalized 10-digit phone (first listed).",
  },
  { name: "website", type: "VARCHAR", kit: false, description: "First listed website." },
  { name: "address_street", type: "VARCHAR", kit: false, description: "Freeform street address." },
  { name: "address_city", type: "VARCHAR", kit: false, description: "Locality." },
  { name: "address_zip", type: "VARCHAR", kit: false, description: "Postal code." },
  { name: "latitude", type: "DOUBLE", kit: false, description: "WGS84 latitude." },
  { name: "longitude", type: "DOUBLE", kit: false, description: "WGS84 longitude." },
  {
    name: "contractor_id",
    type: "VARCHAR",
    kit: false,
    description: "Permit-derived contractor entity matched by phone, when any.",
  },
  {
    name: "source_datasets",
    type: "VARCHAR",
    kit: false,
    description: "'|'-joined Overture source datasets (attribution).",
  },
  {
    name: "overture_release",
    type: "VARCHAR",
    kit: false,
    description: "Pinned Overture release the row came from.",
  },
  {
    name: "source_url",
    type: "VARCHAR",
    kit: false,
    description: "Overture STAC catalog URL for the release.",
  },
  { name: "fetched_at", type: "VARCHAR", kit: false, description: "ISO timestamp of extraction." },
];

export const QUERY_TABLES = {
  properties: PROPERTIES_COLUMNS,
  permits: PERMITS_COLUMNS,
  contractors: CONTRACTORS_COLUMNS,
  places: PLACES_COLUMNS,
} as const;
export type QueryTableName = keyof typeof QUERY_TABLES;
