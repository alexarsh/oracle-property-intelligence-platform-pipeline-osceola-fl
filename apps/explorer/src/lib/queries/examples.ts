/**
 * Example statements for the query console. Each is a single read-only SELECT
 * against the MCP views; parameters are baked in as literals so a presenter
 * can run them verbatim.
 *
 * @module queries/examples
 */
import { OSCEOLA } from "@osceola/shared";
import { haversineSql } from "../mcp/sql";

export interface ExampleQuery {
  id: string;
  title: string;
  table: "properties" | "permits";
  sql: string;
  note: string;
}

const kissimmee = OSCEOLA.places[0]!;
const d = haversineSql(kissimmee.lat, kissimmee.lng);

export const EXAMPLE_QUERIES: readonly ExampleQuery[] = [
  {
    id: "aged-roofs-radius",
    title: `Roofs ≥ ${OSCEOLA.thresholds.roofAgeYears} years within 5 miles of ${kissimmee.name}`,
    table: "properties",
    note: "Haversine over latitude/longitude; roof_age_years is derived from the last roofing permit when one exists, otherwise built_year (see roof_age_basis).",
    sql:
      `SELECT parcel_identifier, address_street, address_city, built_year, roof_age_years, roof_age_basis,\n` +
      `       last_roof_permit_date, owner_name, round(${d}, 2) AS distance_miles, source_urls\n` +
      `FROM properties\n` +
      `WHERE property_type = 'residential'\n` +
      `  AND roof_age_years >= ${OSCEOLA.thresholds.roofAgeYears}\n` +
      `  AND ${d} <= 5\n` +
      `ORDER BY distance_miles\nLIMIT 100`,
  },
  {
    id: "aged-roofs-count",
    title: "Count aged roofs by roof-age basis (5 mi of Kissimmee)",
    table: "properties",
    note: "Shows how many aged roofs rest on a permit date versus the year built.",
    sql:
      `SELECT roof_age_basis, count(*) AS properties, min(roof_age_years) AS min_age, max(roof_age_years) AS max_age\n` +
      `FROM properties\n` +
      `WHERE roof_age_years >= ${OSCEOLA.thresholds.roofAgeYears} AND ${d} <= 5\n` +
      `GROUP BY roof_age_basis ORDER BY properties DESC`,
  },
  {
    id: "long-open-roofing-permits",
    title: `Open roofing permits open > ${OSCEOLA.thresholds.longOpenPermitYears} years, with contractor + BBB`,
    table: "permits",
    note: "days_open counts from the issue/open date to the run date while open. bbb_rating is NULL until the BBB match populates it.",
    sql:
      `SELECT permit_number, permit_issue_date, days_open, round(days_open / 365.25, 1) AS years_open, improvement_status,\n` +
      `       issuing_agency, address_street, address_city, contractor_name, contractor_qualifier, contractor_phone,\n` +
      `       contractor_license, bbb_rating, bbb_accredited, source_url\n` +
      `FROM permits\n` +
      `WHERE is_roofing AND is_open AND days_open > ${OSCEOLA.thresholds.longOpenPermitYears} * 365\n` +
      `ORDER BY days_open DESC\nLIMIT 100`,
  },
  {
    id: "open-roofing-permits-radius",
    title: "Open roofing permits within 5 miles of Kissimmee, longest open first",
    table: "permits",
    sql:
      `SELECT permit_number, days_open, contractor_name, bbb_rating, address_street, address_city,\n` +
      `       round(${d}, 2) AS distance_miles, source_url\n` +
      `FROM permits\n` +
      `WHERE is_roofing AND is_open AND ${d} <= 5\n` +
      `ORDER BY days_open DESC\nLIMIT 100`,
    note: "Same radius expression as the properties query; permits carry the matched parcel centroid.",
  },
  {
    id: "no-sale-10y",
    title: `No ownership change in ${OSCEOLA.thresholds.ownershipTenureYears}+ years`,
    table: "properties",
    note: "years_since_sale is computed from last_sale_date as of the run date.",
    sql:
      `SELECT parcel_identifier, address_street, address_city, owner_name, last_sale_date, years_since_sale, roof_age_years\n` +
      `FROM properties\n` +
      `WHERE property_type = 'residential' AND years_since_sale >= ${OSCEOLA.thresholds.ownershipTenureYears}\n` +
      `ORDER BY years_since_sale DESC\nLIMIT 100`,
  },
  {
    id: "out-of-state-owners",
    title: "Out-of-state owners by mailing state",
    table: "properties",
    note: "owner_out_of_state compares the owner mailing state with FL.",
    sql:
      `SELECT owner_mail_state, count(*) AS properties, count(*) FILTER (WHERE roof_age_years >= 15) AS aged_roofs\n` +
      `FROM properties\n` +
      `WHERE owner_out_of_state\n` +
      `GROUP BY owner_mail_state ORDER BY properties DESC\nLIMIT 50`,
  },
  {
    id: "contractors-open-roofing",
    title: "Contractors with the most open roofing permits",
    table: "permits",
    note: "Contractor identity as recorded on the permit; contractor_id is the reconciled entity.",
    sql:
      `SELECT contractor_name, contractor_license, contractor_phone, bbb_rating, count(*) AS open_roofing_permits, max(days_open) AS longest_open_days\n` +
      `FROM permits\n` +
      `WHERE is_roofing AND is_open AND contractor_name IS NOT NULL\n` +
      `GROUP BY 1,2,3,4 ORDER BY open_roofing_permits DESC\nLIMIT 50`,
  },
];
