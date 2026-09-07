/**
 * Builds the `places` query table (business / POI locations) from Overture
 * places, and links contractor businesses to permit-derived contractor
 * entities by normalized phone number. When the Overture stage has not run,
 * an empty table with the published schema is created so exports stay stable.
 *
 * @module transform/places
 */
import type { Db } from "../duckdb/client.js";
import { phone10 } from "./sql.js";

const CONTRACTOR_TAXONOMY =
  "(roof|contractor|construction|home_improvement|remodel|building_supply|handyman|siding|gutter|solar)";

export async function buildPlaces(db: Db): Promise<number> {
  const hasRaw = await db.tableExists("raw_overture_places");
  if (!hasRaw) {
    await db.run(`CREATE OR REPLACE TABLE places AS SELECT
      NULL::VARCHAR AS place_id, NULL::VARCHAR AS name, NULL::VARCHAR AS taxonomy_primary, NULL::VARCHAR AS taxonomy_hierarchy,
      NULL::VARCHAR AS basic_category, NULL::BOOLEAN AS is_contractor, NULL::VARCHAR AS operating_status, NULL::DOUBLE AS confidence,
      NULL::VARCHAR AS phone, NULL::VARCHAR AS website, NULL::VARCHAR AS address_street, NULL::VARCHAR AS address_city,
      NULL::VARCHAR AS address_zip, NULL::DOUBLE AS latitude, NULL::DOUBLE AS longitude, NULL::VARCHAR AS contractor_id,
      NULL::VARCHAR AS source_datasets, NULL::VARCHAR AS overture_release, NULL::VARCHAR AS source_url, NULL::VARCHAR AS fetched_at
      WHERE false`);
    return 0;
  }
  const hasContractors = await db.tableExists("contractors");
  await db.run(`
    CREATE OR REPLACE TABLE places AS
    WITH base AS (
      SELECT
        gers_id AS place_id, name_primary AS name, taxonomy_primary, taxonomy_hierarchy, basic_category,
        regexp_matches(lower(coalesce(taxonomy_hierarchy, '')), '${CONTRACTOR_TAXONOMY}') AS is_contractor,
        operating_status, confidence,
        ${phone10("phones[1]")} AS phone,
        websites[1] AS website,
        address_freeform AS address_street, address_locality AS address_city, address_postcode AS address_zip,
        latitude, longitude,
        array_to_string(source_datasets, '|') AS source_datasets,
        overture_release,
        'https://stac.overturemaps.org/' || overture_release || '/catalog.json' AS source_url,
        fetched_at::VARCHAR AS fetched_at
      FROM raw_overture_places
    )
    SELECT b.*, ${hasContractors ? "c.contractor_id" : "NULL::VARCHAR AS contractor_id"}
    FROM base b
    ${hasContractors ? "LEFT JOIN (SELECT phone, min(contractor_id) AS contractor_id FROM contractors WHERE phone IS NOT NULL GROUP BY 1) c ON c.phone = b.phone AND b.is_contractor" : ""}`);
  return db.count("places");
}
