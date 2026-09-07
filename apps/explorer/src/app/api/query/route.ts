/**
 * `POST /api/query { table, sql, limit? }` — the query console backend.
 *
 * The statement is pre-checked (single SELECT/WITH) and forwarded verbatim to
 * `queryProperties` / `queryPermits`; the MCP's validator is the authority and
 * its error text is returned to the console unchanged.
 *
 * @module api/query
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, jsonError } from "../_lib";
import { createMcpClient } from "@/lib/mcp/client";
import { assertReadOnlySelect } from "@/lib/mcp/sql";
import { queryPermits, queryProperties } from "@/lib/mcp/tools";
import { mcpPublicUrl } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  table: z.enum(["properties", "permits"]),
  sql: z.string().min(1).max(20_000),
  limit: z.number().int().min(1).max(1000).optional(),
});

export interface QueryResponse {
  table: "properties" | "permits";
  tool: "queryProperties" | "queryPermits";
  endpoint: string;
  sql: string;
  rowCount: number;
  limit: number;
  columns: string[];
  rows: Record<string, unknown>[];
  ms: number;
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return jsonError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    const { table, sql, limit = 100 } = parsed.data;
    const statement = assertReadOnlySelect(sql);
    const mcp = createMcpClient();
    const t0 = Date.now();
    const res =
      table === "properties"
        ? await queryProperties(mcp, statement, limit)
        : await queryPermits(mcp, statement, limit);
    const columns = [...new Set(res.rows.flatMap((r) => Object.keys(r)))];
    const body: QueryResponse = {
      table,
      tool: table === "properties" ? "queryProperties" : "queryPermits",
      endpoint: mcpPublicUrl(),
      sql: statement,
      rowCount: res.rowCount,
      limit: res.limit ?? limit,
      columns,
      rows: res.rows,
      ms: Date.now() - t0,
    };
    return NextResponse.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}
