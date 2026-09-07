/**
 * Contractor entity reconciliation.
 *
 * Permits name contractors inconsistently ("ABC ROOFING LLC", "A B C Roofing",
 * phone-only rows, license-only rows). Following the kit's 3-tier cascade
 * (`bbb-harvest` skill: license > phone > normalized name) every permit is
 * assigned a `contractor_id`, and one `contractors` row is produced per entity
 * with permit statistics. When BBB profiles are present, the same cascade
 * matches entities to BBB ratings and records the match method.
 *
 * Identity resolution is deliberately transitive-free (one key per permit) so
 * it stays explainable: the `identity_basis` column says which key produced
 * the id.
 *
 * @module transform/contractors
 */
import type { Db } from "../duckdb/client.js";
import { normalizedName, phone10 } from "./sql.js";

/**
 * Build `contractor_link` (permit -> contractor id), `contractors`, and — when
 * `raw_bbb_profiles` exists — `contractor_bbb_match`.
 */
export async function buildContractors(db: Db): Promise<{ contractors: number; bbbMatched: number }> {
  // 1. Per-permit identity key. Licenses are unique per contractor; phones are
  //    stable per business; the normalized name is the fallback.
  await db.run(`
    CREATE OR REPLACE TABLE contractor_link AS
    SELECT
      property_improvement_id,
      CASE WHEN contractor_license IS NOT NULL THEN 'license'
           WHEN contractor_phone IS NOT NULL THEN 'phone'
           WHEN contractor_name_norm IS NOT NULL THEN 'name' END AS identity_basis,
      CASE WHEN contractor_license IS NOT NULL THEN 'lic:' || contractor_license
           WHEN contractor_phone IS NOT NULL THEN 'tel:' || contractor_phone
           WHEN contractor_name_norm IS NOT NULL THEN 'name:' || contractor_name_norm END AS identity_key
    FROM permits_stage
    WHERE contractor_license IS NOT NULL OR contractor_phone IS NOT NULL OR contractor_name_norm IS NOT NULL`);
  // Phone-keyed and name-keyed permits that share a phone/name with a
  // license-keyed permit are folded into the licensed identity (one hop).
  await db.run(`
    CREATE OR REPLACE TABLE contractor_key_alias AS
    WITH lic AS (
      SELECT DISTINCT 'lic:' || s.contractor_license AS lic_key, s.contractor_phone, s.contractor_name_norm
      FROM permits_stage s WHERE s.contractor_license IS NOT NULL
    ),
    by_phone AS (SELECT 'tel:' || contractor_phone AS alias_key, min(lic_key) AS lic_key FROM lic WHERE contractor_phone IS NOT NULL GROUP BY 1 HAVING count(DISTINCT lic_key) = 1),
    by_name  AS (SELECT 'name:' || contractor_name_norm AS alias_key, min(lic_key) AS lic_key FROM lic WHERE contractor_name_norm IS NOT NULL GROUP BY 1 HAVING count(DISTINCT lic_key) = 1),
    phone_to_name AS (
      SELECT 'name:' || contractor_name_norm AS alias_key, min('tel:' || contractor_phone) AS lic_key
      FROM permits_stage WHERE contractor_phone IS NOT NULL AND contractor_name_norm IS NOT NULL AND contractor_license IS NULL
      GROUP BY 1 HAVING count(DISTINCT contractor_phone) = 1
    )
    SELECT alias_key, lic_key AS canonical_key FROM by_phone
    UNION ALL SELECT alias_key, lic_key FROM by_name
    UNION ALL SELECT alias_key, lic_key FROM phone_to_name WHERE alias_key NOT IN (SELECT alias_key FROM by_name)`);
  await db.run(`
    CREATE OR REPLACE TABLE contractor_link AS
    SELECT l.property_improvement_id, l.identity_basis, l.identity_key,
           coalesce(a.canonical_key, l.identity_key) AS canonical_key,
           substr(sha256(coalesce(a.canonical_key, l.identity_key)), 1, 32) AS contractor_id
    FROM contractor_link l LEFT JOIN contractor_key_alias a ON a.alias_key = l.identity_key`);

  // 2. One row per entity with the most frequent display name and permit stats.
  await db.run(`
    CREATE OR REPLACE TABLE contractors AS
    WITH joined AS (
      SELECT c.contractor_id, c.canonical_key, s.*
      FROM contractor_link c JOIN permits_stage s USING (property_improvement_id)
    ),
    names AS (
      SELECT contractor_id, contractor_name, count(*) AS n,
             row_number() OVER (PARTITION BY contractor_id ORDER BY count(*) DESC, contractor_name) AS rn
      FROM joined WHERE contractor_name IS NOT NULL GROUP BY 1, 2
    )
    SELECT
      j.contractor_id,
      n.contractor_name AS display_name,
      ${normalizedName("n.contractor_name")} AS normalized_name,
      max(j.contractor_license) AS license_number,
      max(j.contractor_phone) AS phone,
      CASE WHEN j.canonical_key LIKE 'lic:%' THEN 'license' WHEN j.canonical_key LIKE 'tel:%' THEN 'phone' ELSE 'name' END AS identity_basis,
      count(*)::INTEGER AS permit_count,
      count(*) FILTER (WHERE j.is_roofing)::INTEGER AS roofing_permit_count,
      count(*) FILTER (WHERE j.is_roofing AND j.is_open)::INTEGER AS open_roofing_permit_count,
      min(coalesce(j.permit_issue_date, j.opened_date))::VARCHAR AS first_permit_date,
      max(coalesce(j.permit_issue_date, j.opened_date))::VARCHAR AS last_permit_date,
      string_agg(DISTINCT j.source_system, ' | ') AS source_systems
    FROM joined j LEFT JOIN names n ON n.contractor_id = j.contractor_id AND n.rn = 1
    GROUP BY j.contractor_id, j.canonical_key, n.contractor_name`);

  // 3. BBB match (license > phone > normalized name), when profiles exist.
  let bbbMatched = 0;
  if (await db.tableExists("raw_bbb_profiles")) {
    await db.run(`
      CREATE OR REPLACE TABLE contractor_bbb_match AS
      WITH bbb AS (
        SELECT bbb_id, name, rating, accredited, review_count, complaint_count, profile_url,
               ${phone10("phone")} AS phone10, ${normalizedName("name")} AS name_norm,
               unnest(coalesce(license_numbers, [])) AS lic
        FROM raw_bbb_profiles
      ),
      bbb_lic AS (SELECT upper(regexp_replace(lic, '[^A-Za-z0-9]', '', 'g')) AS lic, min(bbb_id) AS bbb_id FROM bbb WHERE lic IS NOT NULL GROUP BY 1),
      bbb_tel AS (SELECT phone10, min(bbb_id) AS bbb_id FROM bbb WHERE phone10 IS NOT NULL GROUP BY 1),
      bbb_nm  AS (SELECT name_norm, min(bbb_id) AS bbb_id FROM bbb WHERE name_norm IS NOT NULL GROUP BY 1 HAVING count(DISTINCT bbb_id) = 1),
      m AS (
        SELECT c.contractor_id,
               coalesce(l.bbb_id, t.bbb_id, nm.bbb_id) AS bbb_id,
               CASE WHEN l.bbb_id IS NOT NULL THEN 'license' WHEN t.bbb_id IS NOT NULL THEN 'phone' WHEN nm.bbb_id IS NOT NULL THEN 'name' END AS bbb_match_method
        FROM contractors c
        LEFT JOIN bbb_lic l ON l.lic = c.license_number
        LEFT JOIN bbb_tel t ON t.phone10 = c.phone
        LEFT JOIN bbb_nm nm ON nm.name_norm = c.normalized_name
      )
      SELECT m.contractor_id, m.bbb_id, m.bbb_match_method,
             p.rating AS bbb_rating, p.accredited AS bbb_accredited, p.review_count AS bbb_review_count,
             p.complaint_count AS bbb_complaint_count, p.profile_url AS bbb_profile_url
      FROM m JOIN raw_bbb_profiles p ON p.bbb_id = m.bbb_id
      WHERE m.bbb_id IS NOT NULL`);
    bbbMatched = await db.count("contractor_bbb_match");
    await db.run(`
      CREATE OR REPLACE TABLE contractors AS
      SELECT c.*, b.bbb_id, b.bbb_rating, b.bbb_accredited, b.bbb_review_count, b.bbb_complaint_count, b.bbb_profile_url, b.bbb_match_method
      FROM contractors c LEFT JOIN contractor_bbb_match b USING (contractor_id)`);
  } else {
    await db.run(`
      CREATE OR REPLACE TABLE contractors AS
      SELECT c.*, NULL::VARCHAR AS bbb_id, NULL::VARCHAR AS bbb_rating, NULL::BOOLEAN AS bbb_accredited,
             NULL::INTEGER AS bbb_review_count, NULL::INTEGER AS bbb_complaint_count, NULL::VARCHAR AS bbb_profile_url, NULL::VARCHAR AS bbb_match_method
      FROM contractors c`);
  }
  return { contractors: await db.count("contractors"), bbbMatched };
}
