/**
 * Contractor-enrichment counters for the Sources page, computed at request time
 * through the MCP `permits` view (the contractors table is not served by the
 * MCP, so contractor entities are counted as distinct `contractor_id`s).
 * Cached for 5 minutes per server instance.
 *
 * @module queries/enrichment
 */
import { unstable_cache } from "next/cache";
import { createMcpClient } from "../mcp/client";
import type { McpDataClient } from "../mcp/client";
import { queryPermits, toNumber, toStr } from "../mcp/tools";

export interface EnrichmentStats {
  contractors: number;
  contractorsRated: number;
  ratedByMethod: Record<string, number>;
  permitsWithContractor: number;
  permitsRated: number;
  permitsAccela: number;
  permitsTotal: number;
  computedAt: string;
}

export const ENRICHMENT_SQL = [
  "SELECT",
  "  count(DISTINCT contractor_id) AS contractors,",
  "  count(DISTINCT contractor_id) FILTER (WHERE bbb_rating IS NOT NULL) AS contractors_rated,",
  "  count(*) FILTER (WHERE contractor_name IS NOT NULL) AS permits_with_contractor,",
  "  count(*) FILTER (WHERE bbb_rating IS NOT NULL) AS permits_rated,",
  "  count(*) FILTER (WHERE source_system = 'osceola_accela') AS permits_accela,",
  "  count(*) AS permits_total",
  "FROM permits",
].join("\n");

export const ENRICHMENT_BY_METHOD_SQL =
  "SELECT bbb_match_method, count(DISTINCT contractor_id) AS contractors FROM permits WHERE bbb_rating IS NOT NULL GROUP BY bbb_match_method ORDER BY contractors DESC";

/** Run both counter queries through the MCP (no cache; used by tests and the cached wrapper). */
export async function computeEnrichment(mcp: McpDataClient): Promise<EnrichmentStats> {
  const [totals, byMethod] = await Promise.all([
    queryPermits(mcp, ENRICHMENT_SQL, 1),
    queryPermits(mcp, ENRICHMENT_BY_METHOD_SQL, 20),
  ]);
  const t = totals.rows[0] ?? {};
  const ratedByMethod: Record<string, number> = {};
  for (const row of byMethod.rows) {
    ratedByMethod[toStr(row.bbb_match_method) ?? "unknown"] = toNumber(row.contractors) ?? 0;
  }
  return {
    contractors: toNumber(t.contractors) ?? 0,
    contractorsRated: toNumber(t.contractors_rated) ?? 0,
    ratedByMethod,
    permitsWithContractor: toNumber(t.permits_with_contractor) ?? 0,
    permitsRated: toNumber(t.permits_rated) ?? 0,
    permitsAccela: toNumber(t.permits_accela) ?? 0,
    permitsTotal: toNumber(t.permits_total) ?? 0,
    computedAt: new Date().toISOString(),
  };
}

/** Cached (5 min) enrichment counters against the configured MCP. */
export const getEnrichment = unstable_cache(
  () => computeEnrichment(createMcpClient()),
  ["osceola-enrichment"],
  {
    revalidate: 300,
  },
);
