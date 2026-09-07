/**
 * Agent tools (Vercel AI SDK `tool()` with Zod schemas). Every data tool calls
 * the Elephant MCP through the shared wrappers; nothing reads Parquet directly.
 *
 * @module agent/tools
 */
import { tool } from "ai";
import { z } from "zod";
import { OSCEOLA } from "@osceola/shared";
import type { McpDataClient } from "../mcp/client";
import { assertReadOnlySelect, haversineSql } from "../mcp/sql";
import {
  findPropertiesInArea,
  getPermitSchema,
  getPropertySchema,
  queryPermits,
  queryProperties,
} from "../mcp/tools";
import { geocodePlace, PLACES } from "./places";

const ROW_CAP = 200;

export interface BbbSummary {
  /** Distinct contractors among the returned rows (by contractor_id, else name). */
  contractors: number;
  matched: number;
  unmatched: number;
  byMethod: Record<string, number>;
  /** Ready-to-paste sentence for the answer. */
  sentence: string;
}

/** Summarize BBB availability for the contractors present in a permits result set. */
export function summarizeBbb(rows: ReadonlyArray<Record<string, unknown>>): BbbSummary | null {
  if (!rows.some((r) => "contractor_name" in r || "contractor_id" in r || "bbb_rating" in r))
    return null;
  const seen = new Map<string, { rated: boolean; method: string | null }>();
  for (const r of rows) {
    const key = (r.contractor_id ?? r.contractor_name) as string | null | undefined;
    if (!key) continue;
    const rated = r.bbb_rating != null && r.bbb_rating !== "";
    const method = typeof r.bbb_match_method === "string" ? r.bbb_match_method : null;
    const prev = seen.get(String(key));
    if (!prev || (rated && !prev.rated)) seen.set(String(key), { rated, method });
  }
  const contractors = seen.size;
  const byMethod: Record<string, number> = {};
  let matched = 0;
  for (const v of seen.values()) {
    if (!v.rated) continue;
    matched++;
    const m = v.method ?? "unknown";
    byMethod[m] = (byMethod[m] ?? 0) + 1;
  }
  const unmatched = contractors - matched;
  const methods = Object.entries(byMethod)
    .map(([m, n]) => `${m} ${n}`)
    .join(", ");
  const sentence =
    contractors === 0
      ? "BBB: no contractor named on the returned permits"
      : matched === 0
        ? `BBB: 0 of ${contractors} contractors matched in this run`
        : `BBB: ${matched} of ${contractors} contractors matched (${methods}); ${unmatched} not matched`;
  return { contractors, matched, unmatched, byMethod, sentence };
}

const RESULT_NOTE =
  "Cite request_identifier and the per-row source_urls / source_url column in your results table.";

/**
 * Build the agent tool set bound to an MCP client. Returned tools are plain
 * `ai` tools so they work with `ToolLoopAgent`, `streamText`, and tests.
 */
export function createAgentTools(mcp: McpDataClient) {
  return {
    getSchema: tool({
      description:
        "Return the column list (name, DuckDB type, description) of the `properties` or `permits` view served by the Elephant MCP for Osceola County. Call this before writing SQL.",
      inputSchema: z.object({
        table: z.enum(["properties", "permits"]).describe("Which view to describe"),
      }),
      execute: async ({ table }) => {
        const schema =
          table === "properties" ? await getPropertySchema(mcp) : await getPermitSchema(mcp);
        return {
          view: schema.view,
          columnCount: schema.columnCount,
          columns: schema.columns,
          notes: [schema.nullabilityNote, schema.safetyNote].filter(Boolean),
        };
      },
    }),
    geocodePlace: tool({
      description:
        "Resolve an Osceola County place name (Kissimmee, St. Cloud, Celebration, Poinciana, Harmony, Buenaventura Lakes, …) to WGS84 latitude/longitude from the pipeline's offline gazetteer. Use the result in the haversine radius expression.",
      inputSchema: z.object({
        place: z.string().min(1).max(80).describe("Place or city name, e.g. 'Kissimmee'"),
      }),
      execute: ({ place }) => {
        const hit = geocodePlace(place);
        if (!hit) return { found: false as const, known: PLACES.map((p) => p.name) };
        return {
          found: true as const,
          name: hit.name,
          lat: hit.lat,
          lng: hit.lng,
          source: hit.source,
          radiusSqlTemplate: `${haversineSql(hit.lat, hit.lng)} <= <miles>`,
        };
      },
    }),
    queryProperties: tool({
      description: `Run ONE read-only SELECT (or WITH … SELECT) over the \`properties\` view (one row per Osceola parcel) via the Elephant MCP over Parquet. Rows are capped at ${ROW_CAP}. Use the haversine expression from geocodePlace for radius filters and ALWAYS select request_identifier, address_street, address_city and source_urls so every listed row can be cited.`,
      inputSchema: z.object({
        sql: z.string().min(6).max(8000).describe("Single SELECT statement over `properties`"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(ROW_CAP)
          .optional()
          .describe(`Row cap (default 100, max ${ROW_CAP})`),
      }),
      execute: async ({ sql, limit }) => {
        const statement = assertReadOnlySelect(sql);
        const res = await queryProperties(mcp, statement, limit ?? 100);
        const first = res.rows[0];
        return {
          view: "properties",
          rowCount: res.rowCount,
          limit: res.limit ?? limit ?? 100,
          truncated: res.rowCount >= (res.limit ?? limit ?? 100),
          rows: res.rows,
          sql: statement,
          note: RESULT_NOTE,
          missingCitationColumns: first
            ? ["request_identifier", "source_urls"].filter((c) => !(c in first))
            : [],
        };
      },
    }),
    queryPermits: tool({
      description: `Run ONE read-only SELECT over the \`permits\` view (one row per building permit; is_roofing, is_open, days_open, contractor_*, bbb_* columns) via the Elephant MCP. Rows are capped at ${ROW_CAP}. Join to properties in your head by parcel_identifier, or filter permits by the same haversine radius (permits carry the parcel centroid). ALWAYS select parcel_identifier, permit_number, contractor_name, bbb_rating, bbb_match_method and source_url; the result includes a bbbSummary sentence you must quote.`,
      inputSchema: z.object({
        sql: z.string().min(6).max(8000).describe("Single SELECT statement over `permits`"),
        limit: z.number().int().min(1).max(ROW_CAP).optional(),
      }),
      execute: async ({ sql, limit }) => {
        const statement = assertReadOnlySelect(sql);
        const res = await queryPermits(mcp, statement, limit ?? 100);
        const first = res.rows[0];
        return {
          view: "permits",
          rowCount: res.rowCount,
          limit: res.limit ?? limit ?? 100,
          truncated: res.rowCount >= (res.limit ?? limit ?? 100),
          rows: res.rows,
          sql: statement,
          bbbSummary: summarizeBbb(res.rows),
          note: RESULT_NOTE,
          missingCitationColumns: first
            ? ["parcel_identifier", "source_url"].filter((c) => !(c in first))
            : [],
        };
      },
    }),
    findPropertiesInArea: tool({
      description:
        "Return parcel identifiers and centroids inside a bounding box (Elephant MCP geo tool). Prefer queryProperties with a haversine filter for radius questions; use this for rectangular map selections.",
      inputSchema: z.object({
        bbox: z.object({
          minLat: z
            .number()
            .min(OSCEOLA.bbox.minLat - 1)
            .max(OSCEOLA.bbox.maxLat + 1),
          maxLat: z
            .number()
            .min(OSCEOLA.bbox.minLat - 1)
            .max(OSCEOLA.bbox.maxLat + 1),
          minLng: z
            .number()
            .min(OSCEOLA.bbox.minLng - 1)
            .max(OSCEOLA.bbox.maxLng + 1),
          maxLng: z
            .number()
            .min(OSCEOLA.bbox.minLng - 1)
            .max(OSCEOLA.bbox.maxLng + 1),
        }),
      }),
      execute: async ({ bbox }) => {
        const res = await findPropertiesInArea(mcp, { bbox });
        return {
          count: res.count,
          sample: res.parcels.slice(0, 50),
          truncated: res.parcels.length > 50,
        };
      },
    }),
  };
}

export type AgentTools = ReturnType<typeof createAgentTools>;
