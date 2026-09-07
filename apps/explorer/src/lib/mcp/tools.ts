/**
 * Typed wrappers around the Elephant MCP tools the explorer uses.
 *
 * Every wrapper takes the {@link McpDataClient} explicitly so route handlers,
 * server components and the agent tools share one code path and tests can
 * inject a fake.
 *
 * Numeric columns arrive from the MCP as JSON numbers or, for BIGINT, as
 * decimal strings; {@link toNumber} normalizes both.
 *
 * @module mcp/tools
 */
import { z } from "zod";
import { COUNTY_KEY } from "../env";
import { cellText } from "../format";
import type { McpDataClient } from "./client";

export const QueryResultSchema = z.object({
  county: z.string().nullable().optional(),
  rowCount: z.number(),
  limit: z.number().optional(),
  rows: z.array(z.record(z.unknown())),
});
export type QueryResult = z.infer<typeof QueryResultSchema>;

export const SchemaColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().nullable().optional(),
});
export const QuerySchemaSchema = z.object({
  county: z.string(),
  view: z.string(),
  columnCount: z.number(),
  columns: z.array(SchemaColumnSchema),
  nullabilityNote: z.string().optional(),
  safetyNote: z.string().optional(),
});
export type QuerySchema = z.infer<typeof QuerySchemaSchema>;

export const PermitCoverageSchema = z.object({
  county: z.string(),
  view: z.string(),
  sources: z.array(
    z.object({
      source_system: z.string().nullable(),
      permit_count: z.number(),
      earliest_date: z.string().nullable(),
      latest_date: z.string().nullable(),
    }),
  ),
  totalPermits: z.number(),
  coverageNote: z.string().optional(),
});
export type PermitCoverage = z.infer<typeof PermitCoverageSchema>;

export const AreaResultSchema = z
  .object({
    count: z.number(),
    parcels: z.array(
      z.object({
        parcelIdentifier: z.string().nullable(),
        requestIdentifier: z.string().nullable().optional(),
        latitude: z.number().nullable(),
        longitude: z.number().nullable(),
        currentAvmValue: z.number().nullable().optional(),
        propertyType: z.string().nullable().optional(),
      }),
    ),
  })
  .passthrough();
export type AreaResult = z.infer<typeof AreaResultSchema>;

export type Row = Record<string, unknown>;

/** Coerce MCP cell values (number | numeric string | null) to a number. */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return null;
}

/** Coerce to string (ids that DuckDB emits as numbers stay lossless as strings). */
export function toStr(v: unknown): string | null {
  if (v == null) return null;
  return cellText(v);
}

export function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

/** `getPropertyQuerySchema` for Osceola. */
export async function getPropertySchema(mcp: McpDataClient): Promise<QuerySchema> {
  return QuerySchemaSchema.parse(
    await mcp.callToolJson("getPropertyQuerySchema", { county: COUNTY_KEY }),
  );
}

/** `getPermitQuerySchema` for Osceola. */
export async function getPermitSchema(mcp: McpDataClient): Promise<QuerySchema> {
  return QuerySchemaSchema.parse(
    await mcp.callToolJson("getPermitQuerySchema", { county: COUNTY_KEY }),
  );
}

/** `queryProperties` — one read-only SELECT over the `properties` view (rows capped by the MCP). */
export async function queryProperties(
  mcp: McpDataClient,
  sql: string,
  limit = 100,
): Promise<QueryResult> {
  return QueryResultSchema.parse(
    await mcp.callToolJson("queryProperties", { county: COUNTY_KEY, sql, limit }),
  );
}

/** `queryPermits` — one read-only SELECT over the `permits` view. */
export async function queryPermits(
  mcp: McpDataClient,
  sql: string,
  limit = 100,
): Promise<QueryResult> {
  return QueryResultSchema.parse(
    await mcp.callToolJson("queryPermits", { county: COUNTY_KEY, sql, limit }),
  );
}

/** `getPermitCoverage` — permit counts by source system. */
export async function getPermitCoverage(mcp: McpDataClient): Promise<PermitCoverage> {
  return PermitCoverageSchema.parse(
    await mcp.callToolJson("getPermitCoverage", { county: COUNTY_KEY }),
  );
}

export interface BBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** `findPropertiesInArea` — parcels whose centroid falls in a bbox or polygon. */
export async function findPropertiesInArea(
  mcp: McpDataClient,
  area: { bbox: BBox } | { polygon: Array<{ lat: number; lng: number }> },
): Promise<AreaResult> {
  return AreaResultSchema.parse(
    await mcp.callToolJson("findPropertiesInArea", { county: COUNTY_KEY, ...area }),
  );
}
