/**
 * Builds the `properties` query table (one row per appraiser folio / STRAP).
 *
 * Phase 1 `buildPropertiesBase` joins the appraiser roll (parcel, situs, owners,
 * mailing address, primary building, detail, latest sale, DOR use code lookup)
 * with GIS centroids. Phase 2 `buildProperties` adds the roofing-lead columns
 * derived from the finished `permits` table and the run lineage columns.
 *
 * Column set = the kit's query-table schema (so the stock Elephant MCP serves it
 * unchanged) + the roofing extensions declared in `@osceola/shared`.
 *
 * @module transform/properties
 */
import type { Db } from "../duckdb/client.js";
import { lit } from "../duckdb/client.js";
import { num, ocpaDate, parcelKey, rowHash, txt, year } from "./sql.js";

const PROPERTY_HASH_COLS = [
  "address_street",
  "address_city",
  "address_zip",
  "latitude",
  "longitude",
  "lot_size_acre",
  "property_usage_type",
  "built_year",
  "effective_year",
  "livable_floor_area",
  "total_area",
  "assessed_value",
  "market_value",
  "land_value",
  "owner_name",
  "owners_text",
  "owner_count",
  "last_sale_date",
  "last_sale_price",
  "subdivision",
  "permit_count",
  "last_roof_permit_date",
  "open_roof_permit_count",
  "owner_mail_city",
  "owner_mail_state",
  "owner_mail_country",
];

/** Phase 1: appraiser roll + GIS -> `properties_base` (no permit-derived columns yet). */
export async function buildPropertiesBase(db: Db): Promise<number> {
  const hasGis = await db.tableExists("raw_gis_parcels");
  await db.run(`
    CREATE OR REPLACE TABLE properties_base AS
    WITH parcel AS (
      SELECT ${parcelKey("strap")} AS strap, ${txt("dor_cd")} AS dor_cd,
             ${num("jst_val")} AS market_value, ${num("asd_val")} AS assessed_value, ${num("tot_lnd_val")} AS land_value,
             ${ocpaDate("own_dt")} AS ownership_date
      FROM raw_ocpa_parcel WHERE ${txt("strap")} IS NOT NULL
      QUALIFY row_number() OVER (PARTITION BY ${parcelKey("strap")} ORDER BY strap) = 1
    ),
    site AS (
      SELECT ${parcelKey("strap")} AS strap,
             nullif(concat_ws(' ', ${txt("str_num")}, ${txt("str_pfx")}, ${txt("str")}, ${txt("str_sfx")}, ${txt("str_sfx_dir")},
                    CASE WHEN ${txt("str_unit")} IS NOT NULL THEN '#' || trim(str_unit) END), '') AS address_street,
             ${txt("city")} AS address_city, left(${txt("zip")}, 5) AS address_zip
      FROM raw_ocpa_site
      QUALIFY row_number() OVER (PARTITION BY ${parcelKey("strap")} ORDER BY TRY_CAST(bld_num AS INTEGER) NULLS LAST, TRY_CAST(ln_num AS INTEGER) NULLS LAST) = 1
    ),
    owners AS (
      SELECT ${parcelKey("strap")} AS strap,
             arg_min(${txt('"Name"')}, TRY_CAST(ln_num AS INTEGER)) AS owner_name,
             string_agg(${txt('"Name"')}, ' | ' ORDER BY TRY_CAST(ln_num AS INTEGER)) AS owners_text,
             count(*)::BIGINT AS owner_count
      FROM raw_ocpa_owner WHERE ${txt('"Name"')} IS NOT NULL GROUP BY 1
    ),
    mail AS (
      SELECT ${parcelKey("strap")} AS strap, ${txt("addr_1")} AS mail_addr, ${txt("city")} AS owner_mail_city,
             ${txt("state")} AS owner_mail_state, left(${txt("zip")}, 5) AS owner_mail_zip,
             coalesce(${txt("country_cd")}, ${txt("country")}) AS owner_mail_country
      FROM raw_ocpa_mail
      QUALIFY row_number() OVER (PARTITION BY ${parcelKey("strap")} ORDER BY TRY_CAST(ln_num AS INTEGER) NULLS LAST) = 1
    ),
    bld AS (
      SELECT ${parcelKey("strap")} AS strap,
             min(${year("act")}) AS built_year,
             max(${year("eff")}) AS effective_year,
             sum(${num("heat_ar")}) AS livable_floor_area,
             sum(${num("gross_ar")}) AS total_area
      FROM raw_ocpa_building GROUP BY 1
    ),
    detail AS (
      SELECT ${parcelKey("strap")} AS strap, ${num("acreage")} AS lot_size_acre, ${num("sqft")} AS lot_area_sqft, ${txt("sub")} AS sub_id
      FROM raw_ocpa_detail
      QUALIFY row_number() OVER (PARTITION BY ${parcelKey("strap")} ORDER BY strap) = 1
    ),
    sale AS (
      SELECT ${parcelKey("strap")} AS strap,
             arg_max(${ocpaDate("dos")}, ${ocpaDate("dos")}) AS last_sale_date,
             arg_max(${num("price")}, ${ocpaDate("dos")}) AS last_sale_price
      FROM raw_ocpa_sales WHERE ${ocpaDate("dos")} IS NOT NULL GROUP BY 1
    ),
    dor AS (SELECT ${txt("dor_cd")} AS dor_cd, ${txt("dscr")} AS dscr, ${txt("dept")} AS dept FROM raw_ocpa_lu_dor),
    sub AS (SELECT ${txt("id")} AS id, ${txt("dscr")} AS dscr FROM raw_ocpa_lu_sub),
    county_zips AS (SELECT DISTINCT address_zip AS zip FROM site WHERE address_zip IS NOT NULL)
    SELECT
      substr(sha256(concat('osceola:', p.strap)), 1, 32) AS property_id,
      NULL::VARCHAR AS property_cid,
      p.strap AS request_identifier,
      p.strap AS parcel_identifier,
      'osceola_appraiser' AS source_system,
      'Osceola' AS county_name,
      'FL' AS state_code,
      s.address_street, s.address_city, s.address_zip,
      ${hasGis ? "g.latitude, g.longitude, g.year_built AS gis_year_built" : "NULL::DOUBLE AS latitude, NULL::DOUBLE AS longitude, NULL::BIGINT AS gis_year_built"},
      coalesce(d.lot_size_acre, d.lot_area_sqft / 43560.0) AS lot_size_acre,
      coalesce(d.lot_area_sqft, d.lot_size_acre * 43560.0) AS lot_area_sqft,
      NULL::VARCHAR AS exterior_wall_material,
      NULL::VARCHAR AS roof_covering_material,
      CASE
        WHEN dor.dept = 'RES' OR left(p.dor_cd, 2) BETWEEN '00' AND '09' THEN 'residential'
        WHEN dor.dept = 'COM' OR left(p.dor_cd, 2) BETWEEN '10' AND '39' THEN 'commercial'
        WHEN dor.dept = 'IND' OR left(p.dor_cd, 2) BETWEEN '40' AND '49' THEN 'industrial'
        WHEN dor.dept = 'AGR' OR left(p.dor_cd, 2) BETWEEN '50' AND '69' THEN 'agricultural'
        WHEN left(p.dor_cd, 2) BETWEEN '70' AND '79' THEN 'institutional'
        WHEN left(p.dor_cd, 2) BETWEEN '80' AND '89' THEN 'government'
        ELSE 'other' END AS property_type,
      dor.dscr AS property_usage_type,
      p.dor_cd AS dor_code,
      coalesce(b.built_year, ${hasGis ? "g.year_built" : "NULL"}) AS built_year,
      b.effective_year,
      b.livable_floor_area, b.total_area,
      p.assessed_value, p.market_value, p.land_value,
      NULL::DOUBLE AS avm_value,
      o.owner_name, o.owners_text, o.owner_count,
      (m.mail_addr IS NOT NULL AND s.address_street IS NOT NULL
         AND upper(regexp_replace(m.mail_addr, '[^A-Za-z0-9]', '', 'g')) = upper(regexp_replace(s.address_street, '[^A-Za-z0-9]', '', 'g'))) AS owner_occupied,
      coalesce(sale.last_sale_date, p.ownership_date)::VARCHAR AS last_sale_date,
      sale.last_sale_price,
      sub.dscr AS subdivision,
      NULL::BOOLEAN AS has_sunbiz_tenant,
      NULL::BOOLEAN AS has_pa_corp_tenant,
      NULL::BOOLEAN AS hoa_flag,
      m.owner_mail_city, m.owner_mail_state, m.owner_mail_country,
      CASE WHEN m.owner_mail_zip IS NULL THEN NULL ELSE m.owner_mail_zip NOT IN (SELECT zip FROM county_zips) END AS owner_out_of_county,
      CASE WHEN m.owner_mail_state IS NULL THEN NULL ELSE upper(m.owner_mail_state) <> 'FL' END AS owner_out_of_state,
      p.ownership_date::VARCHAR AS ownership_date
    FROM parcel p
    LEFT JOIN site s USING (strap)
    LEFT JOIN owners o USING (strap)
    LEFT JOIN mail m USING (strap)
    LEFT JOIN bld b USING (strap)
    LEFT JOIN detail d USING (strap)
    LEFT JOIN sale USING (strap)
    LEFT JOIN dor ON dor.dor_cd = p.dor_cd
    LEFT JOIN sub ON sub.id = d.sub_id
    ${hasGis ? "LEFT JOIN raw_gis_parcels g ON g.parcel_no = p.strap" : ""}`);
  return db.count("properties_base");
}

/** Phase 2: `properties` = base + permit/roof aggregates + lineage. Requires `permits`. */
export async function buildProperties(db: Db, runId: string, runDate: string): Promise<number> {
  const hasPrev = await db.tableExists("properties");
  await db.run(`CREATE OR REPLACE TABLE properties_prev AS
    SELECT property_id, first_seen_run_id, last_changed_run_id, row_hash
    FROM ${hasPrev ? "properties" : "(SELECT NULL::VARCHAR AS property_id, NULL::VARCHAR AS first_seen_run_id, NULL::VARCHAR AS last_changed_run_id, NULL::VARCHAR AS row_hash WHERE false)"}`);
  await db.run(`
    CREATE OR REPLACE TABLE properties AS
    WITH agg AS (
      SELECT parcel_identifier,
             count(DISTINCT permit_number)::BIGINT AS permit_count,
             max(CASE WHEN is_roofing AND improvement_status = 'finaled' THEN coalesce(permit_close_date, permit_issue_date, opened_date) END) AS last_roof_permit_date,
             arg_max(CASE WHEN is_roofing AND improvement_status = 'finaled' THEN permit_number END,
                     CASE WHEN is_roofing AND improvement_status = 'finaled' THEN coalesce(permit_close_date, permit_issue_date, opened_date) END) AS last_roof_permit_number,
             arg_max(CASE WHEN is_roofing THEN improvement_status END,
                     CASE WHEN is_roofing THEN coalesce(permit_issue_date, opened_date, permit_close_date) END) AS last_roof_permit_status,
             count(*) FILTER (WHERE is_roofing AND is_open)::INTEGER AS open_roof_permit_count,
             max(CASE WHEN is_roofing AND is_open THEN days_open END)::INTEGER AS oldest_open_roof_permit_days,
             bool_or(bbb_rating IS NOT NULL) AS has_bbb_contractor,
             string_agg(DISTINCT source_url, ' | ') AS permit_source_urls
      FROM permits GROUP BY 1
    ),
    joined AS (
      SELECT b.*,
             coalesce(a.permit_count, 0) AS permit_count,
             a.permit_count IS NOT NULL AS has_permits,
             a.last_roof_permit_date,
             a.last_roof_permit_number,
             a.last_roof_permit_status,
             coalesce(a.open_roof_permit_count, 0) AS open_roof_permit_count,
             a.oldest_open_roof_permit_days,
             coalesce(a.has_bbb_contractor, false) AS has_bbb_contractor,
             CASE WHEN a.last_roof_permit_date IS NOT NULL THEN 'roof_permit' WHEN b.built_year IS NOT NULL THEN 'built_year' ELSE 'unknown' END AS roof_age_basis,
             CASE WHEN a.last_roof_permit_date IS NOT NULL THEN year(DATE '${runDate}') - year(TRY_CAST(a.last_roof_permit_date AS DATE))
                  WHEN b.built_year IS NOT NULL THEN year(DATE '${runDate}') - b.built_year END::INTEGER AS roof_age_years,
             CASE WHEN b.last_sale_date IS NOT NULL THEN round(date_diff('day', TRY_CAST(b.last_sale_date AS DATE), DATE '${runDate}') / 365.25, 2) END AS years_since_sale,
             concat_ws(' | ', 'https://www.property-appraiser.org/data/',
                       'https://services6.arcgis.com/9zKHLCgIwu2HFA5O/arcgis/rest/services/Parcels/FeatureServer/0',
                       a.permit_source_urls) AS source_urls
      FROM properties_base b LEFT JOIN agg a ON a.parcel_identifier = b.request_identifier
    ),
    hashed AS (SELECT j.*, ${rowHash(PROPERTY_HASH_COLS)} AS row_hash FROM joined j)
    SELECT
      h.property_id, h.property_cid, h.request_identifier, h.parcel_identifier, h.source_system, h.county_name, h.state_code,
      h.address_street, h.address_city, h.address_zip, h.latitude, h.longitude, h.lot_size_acre, h.lot_area_sqft,
      h.exterior_wall_material, h.roof_covering_material, h.property_type, h.property_usage_type, h.built_year,
      h.livable_floor_area, h.total_area, h.assessed_value, h.market_value, h.land_value, h.avm_value,
      h.owner_name, h.owners_text, h.owner_count, h.owner_occupied, h.last_sale_date, h.last_sale_price, h.subdivision,
      h.has_permits, h.permit_count, h.has_sunbiz_tenant, h.has_bbb_contractor, h.has_pa_corp_tenant, h.hoa_flag,
      h.effective_year, h.last_roof_permit_date, h.last_roof_permit_number, h.last_roof_permit_status, h.roof_age_basis, h.roof_age_years, h.open_roof_permit_count,
      h.oldest_open_roof_permit_days, h.years_since_sale, h.owner_mail_city, h.owner_mail_state, h.owner_mail_country,
      h.owner_out_of_county, h.owner_out_of_state, h.gis_year_built, h.source_urls,
      coalesce(prev.first_seen_run_id, ${lit(runId)}) AS first_seen_run_id,
      CASE WHEN prev.row_hash = h.row_hash THEN prev.last_changed_run_id ELSE ${lit(runId)} END AS last_changed_run_id,
      h.row_hash
    FROM hashed h LEFT JOIN properties_prev prev ON prev.property_id = h.property_id`);
  await db.run(`DROP TABLE properties_prev`);
  return db.count("properties");
}
