/**
 * Builds the `permits` query table from every permit source present in the
 * raw layer:
 *
 * - `raw_ocpa_permit` — the appraiser's permit feed (county + both cities, back to
 *   the 1990s; structured dates, contractor name/phone, no license numbers).
 * - `raw_accela_permits` — the county's Accela portal (current, incremental;
 *   status, dates, licensed professional with license number).
 *
 * Both are normalized into the kit's permit schema plus the roofing-lead
 * extensions declared in `@osceola/shared`. Rows are never merged across
 * sources: `source_system` keeps provenance explicit, and the properties table
 * counts distinct permit numbers.
 *
 * The build is two-phase so contractors can be reconciled in between:
 * `buildPermitsStage` (normalize + classify) -> `buildContractors` (identity) ->
 * `buildPermits` (final table with contractor ids, BBB, geometry and run lineage).
 *
 * @module transform/permits
 */
import type { Db } from "../duckdb/client.js";
import { lit } from "../duckdb/client.js";
import {
  contractorBusiness,
  contractorQualifier,
  isRoofing,
  normalizedName,
  num,
  ocpaDate,
  parcelKey,
  phone10,
  rowHash,
  txt,
} from "./sql.js";

/** Business columns whose change bumps `last_changed_run_id`. */
const PERMIT_HASH_COLS = [
  "parcel_identifier",
  "improvement_type",
  "improvement_status",
  "improvement_action",
  "permit_issue_date",
  "application_received_date",
  "final_inspection_date",
  "permit_close_date",
  "completion_date",
  "expiration_date",
  "opened_date",
  "description",
  "estimated_job_value",
  "contractor_name",
  "contractor_qualifier",
  "contractor_phone",
  "contractor_license",
];

/** Appraiser-feed permits -> staging shape. */
function ocpaPermitsSql(): string {
  const closeDate = `coalesce(${ocpaDate("final_dt")}, ${ocpaDate("co_dt")}, ${ocpaDate("sign_off_dt")}, ${ocpaDate("cancel_dt")})`;
  return `
  SELECT
    trim(permit_num)                                     AS permit_number,
    ${parcelKey("strap")}                                AS parcel_identifier,
    CASE upper(trim(coalesce(status, '')))
      WHEN 'C' THEN 'finaled' WHEN 'V' THEN 'voided' WHEN 'P' THEN 'open' WHEN 'A' THEN 'open' WHEN 'O' THEN 'open'
      ELSE CASE WHEN coalesce(${ocpaDate("final_dt")}, ${ocpaDate("co_dt")}, ${ocpaDate("sign_off_dt")}) IS NOT NULL THEN 'finaled'
                WHEN ${ocpaDate("cancel_dt")} IS NOT NULL THEN 'voided' ELSE 'open' END
    END                                                  AS improvement_status,
    ${txt("permit_type")}                                AS improvement_action,
    ${ocpaDate("issue_dt")}                              AS permit_issue_date,
    ${ocpaDate("submit_dt")}                             AS application_received_date,
    ${ocpaDate("final_dt")}                              AS final_inspection_date,
    ${closeDate}                                         AS permit_close_date,
    coalesce(${ocpaDate("co_dt")}, ${ocpaDate("sign_off_dt")}) AS completion_date,
    NULL::DATE                                           AS expiration_date,
    coalesce(${ocpaDate("submit_dt")}, ${ocpaDate("key_dt")}, ${ocpaDate("issue_dt")}) AS opened_date,
    'osceola_appraiser'                                  AS source_system,
    ${txt("dscr")}                                       AS description,
    coalesce(${num("est_val")}, ${num("calc_val")})      AS estimated_job_value,
    CASE upper(trim(coalesce(agency_id, ''))) WHEN 'C' THEN 'Osceola County' WHEN 'K' THEN 'City of Kissimmee' WHEN 'S' THEN 'City of St. Cloud' END AS issuing_agency,
    ${contractorBusiness("contractor")}                  AS contractor_name,
    ${contractorQualifier("contractor")}                 AS contractor_qualifier,
    ${phone10("contractor_tel")}                         AS contractor_phone,
    NULL::VARCHAR                                        AS contractor_license,
    nullif(concat_ws(' ', ${txt("site_num")}, ${txt("site_pfx")}, ${txt("site_str")}, ${txt("site_tp")}, ${txt("site_sfx")}), '') AS address_street,
    NULL::VARCHAR                                        AS address_city,
    ${txt("site_zip")}                                   AS address_zip,
    'https://www.property-appraiser.org/data/'           AS source_url,
    (SELECT max(fetched_at) FROM source_loads WHERE source = 'ocpa_certified')::VARCHAR AS fetched_at
  FROM raw_ocpa_permit
  WHERE ${txt("permit_num")} IS NOT NULL AND ${txt("strap")} IS NOT NULL
  QUALIFY row_number() OVER (PARTITION BY trim(permit_num), ${parcelKey("strap")} ORDER BY ${ocpaDate("issue_dt")} DESC NULLS LAST) = 1`;
}

/** Accela-portal permits -> staging shape (only when the raw table exists). */
function accelaPermitsSql(): string {
  return `
  SELECT
    permit_number,
    ${parcelKey("parcel_number")}                        AS parcel_identifier,
    CASE
      WHEN regexp_matches(lower(coalesce(status, '')), '(final|closed|complete|c/o issued|co issued)') THEN 'finaled'
      WHEN regexp_matches(lower(coalesce(status, '')), '(void|cancel|withdrawn|denied|revoked)') THEN 'voided'
      WHEN regexp_matches(lower(coalesce(status, '')), 'expired') THEN 'expired'
      WHEN finaled_date IS NOT NULL OR closed_date IS NOT NULL THEN 'finaled'
      ELSE 'open' END                                    AS improvement_status,
    record_type                                          AS improvement_action,
    TRY_CAST(issued_date AS DATE)                        AS permit_issue_date,
    TRY_CAST(opened_date AS DATE)                        AS application_received_date,
    TRY_CAST(finaled_date AS DATE)                       AS final_inspection_date,
    coalesce(TRY_CAST(closed_date AS DATE), TRY_CAST(finaled_date AS DATE)) AS permit_close_date,
    TRY_CAST(finaled_date AS DATE)                       AS completion_date,
    TRY_CAST(expiration_date AS DATE)                    AS expiration_date,
    TRY_CAST(opened_date AS DATE)                        AS opened_date,
    'osceola_accela'                                     AS source_system,
    description,
    job_value                                            AS estimated_job_value,
    'Osceola County'                                     AS issuing_agency,
    coalesce(contractor_business_name, contractor_name)  AS contractor_name,
    CASE WHEN contractor_business_name IS NOT NULL THEN contractor_name END AS contractor_qualifier,
    ${phone10("contractor_phone")}                       AS contractor_phone,
    nullif(upper(regexp_replace(coalesce(contractor_license, ''), '[^A-Za-z0-9]', '', 'g')), '') AS contractor_license,
    address                                              AS address_street,
    NULL::VARCHAR                                        AS address_city,
    NULL::VARCHAR                                        AS address_zip,
    source_url,
    fetched_at
  FROM raw_accela_permits
  QUALIFY row_number() OVER (PARTITION BY permit_number ORDER BY fetched_at DESC) = 1`;
}

/**
 * Phase 1: normalize every source into `permits_stage` with classification,
 * open/close derivation and duration.
 */
export async function buildPermitsStage(db: Db, runDate: string): Promise<number> {
  const hasAccela = await db.tableExists("raw_accela_permits");
  const roofing = isRoofing("improvement_action", "description");
  await db.run(`
    CREATE OR REPLACE TABLE permits_stage AS
    WITH src AS (${ocpaPermitsSql()} ${hasAccela ? `UNION ALL BY NAME ${accelaPermitsSql()}` : ""}),
    typed AS (
      SELECT *,
        CASE WHEN ${roofing} THEN 'Roofing'
             WHEN upper(coalesce(improvement_action, '')) IN ('SCRR', 'SE', 'SR') THEN 'Screen enclosure'
             WHEN upper(coalesce(improvement_action, '')) IN ('PO', 'SPA') THEN 'Pool'
             WHEN upper(coalesce(improvement_action, '')) IN ('FE', 'FEC') THEN 'Fence'
             WHEN upper(coalesce(improvement_action, '')) IN ('SF', 'SFR', 'TH', 'CND', 'DPLX', 'BP', 'CMNC', 'MHBD', 'MBHD') THEN 'New construction'
             WHEN upper(coalesce(improvement_action, '')) IN ('RADD', 'RALT', 'CMAL', 'CMAD', 'CALT', 'TBO', 'NA', 'REPR') THEN 'Addition / alteration'
             WHEN upper(coalesce(improvement_action, '')) = 'DM' THEN 'Demolition'
             ELSE 'Other' END AS improvement_type,
        ${roofing} AS is_roofing
      FROM src
    ),
    with_open AS (
      SELECT *,
        (improvement_status = 'open' AND permit_close_date IS NULL) AS is_open,
        date_diff('day', coalesce(permit_issue_date, opened_date),
                  CASE WHEN improvement_status = 'open' AND permit_close_date IS NULL THEN DATE '${runDate}'
                       ELSE coalesce(permit_close_date, DATE '${runDate}') END) AS days_open
      FROM typed
    )
    SELECT
      substr(sha256(concat(source_system, ':', permit_number, ':', parcel_identifier)), 1, 32) AS property_improvement_id,
      substr(sha256(concat('osceola:', parcel_identifier)), 1, 32) AS property_id,
      w.*,
      ${normalizedName("contractor_name")} AS contractor_name_norm,
      ${rowHash(PERMIT_HASH_COLS)} AS row_hash
    FROM with_open w`);
  return db.count("permits_stage");
}

/**
 * Phase 3: the published `permits` table. Requires `properties_base`,
 * `contractor_link` (and optionally `contractor_bbb_match`, `raw_gis_parcels`).
 * Carries `first_seen_run_id` / `last_changed_run_id` forward when the row hash
 * is unchanged, so incremental runs expose exactly what changed.
 */
export async function buildPermits(db: Db, runId: string): Promise<number> {
  const hasPrev = await db.tableExists("permits");
  const hasGis = await db.tableExists("raw_gis_parcels");
  const hasBbb = await db.tableExists("contractor_bbb_match");
  await db.run(`CREATE OR REPLACE TABLE permits_prev AS
    SELECT property_improvement_id, first_seen_run_id, last_changed_run_id, row_hash
    FROM ${hasPrev ? "permits" : "(SELECT NULL::VARCHAR AS property_improvement_id, NULL::VARCHAR AS first_seen_run_id, NULL::VARCHAR AS last_changed_run_id, NULL::VARCHAR AS row_hash WHERE false)"}`);

  await db.run(`
    CREATE OR REPLACE TABLE permits AS
    SELECT
      s.property_improvement_id,
      CASE WHEN p.request_identifier IS NOT NULL THEN s.property_id END AS property_id,
      s.parcel_identifier, s.permit_number, s.improvement_type, s.improvement_status, s.improvement_action,
      s.permit_issue_date::VARCHAR AS permit_issue_date,
      s.application_received_date::VARCHAR AS application_received_date,
      s.final_inspection_date::VARCHAR AS final_inspection_date,
      s.permit_close_date::VARCHAR AS permit_close_date,
      s.completion_date::VARCHAR AS completion_date,
      s.expiration_date::VARCHAR AS expiration_date,
      s.opened_date::VARCHAR AS opened_date,
      s.source_system,
      'Osceola' AS county_name,
      s.description AS project_description,
      s.description,
      s.estimated_job_value,
      NULL::DOUBLE AS fee,
      s.is_roofing, s.is_open, s.days_open::INTEGER AS days_open, s.issuing_agency,
      s.contractor_name, s.contractor_qualifier, s.contractor_phone, s.contractor_license,
      c.contractor_id,
      ${hasBbb ? "b.bbb_rating, b.bbb_accredited, b.bbb_profile_url, b.bbb_match_method" : "NULL::VARCHAR AS bbb_rating, NULL::BOOLEAN AS bbb_accredited, NULL::VARCHAR AS bbb_profile_url, NULL::VARCHAR AS bbb_match_method"},
      ${hasGis ? "g.latitude, g.longitude" : "NULL::DOUBLE AS latitude, NULL::DOUBLE AS longitude"},
      coalesce(s.address_street, p.address_street) AS address_street,
      coalesce(s.address_city, p.address_city) AS address_city,
      coalesce(s.address_zip, p.address_zip) AS address_zip,
      s.source_url, s.fetched_at,
      coalesce(prev.first_seen_run_id, ${lit(runId)}) AS first_seen_run_id,
      CASE WHEN prev.row_hash = s.row_hash THEN prev.last_changed_run_id ELSE ${lit(runId)} END AS last_changed_run_id,
      s.row_hash
    FROM permits_stage s
    LEFT JOIN properties_base p ON p.request_identifier = s.parcel_identifier
    LEFT JOIN contractor_link c ON c.property_improvement_id = s.property_improvement_id
    ${hasBbb ? "LEFT JOIN contractor_bbb_match b ON b.contractor_id = c.contractor_id" : ""}
    ${hasGis ? "LEFT JOIN raw_gis_parcels g ON g.parcel_no = s.parcel_identifier" : ""}
    LEFT JOIN permits_prev prev ON prev.property_improvement_id = s.property_improvement_id`);
  await db.run(`DROP TABLE permits_prev`);
  return db.count("permits");
}
