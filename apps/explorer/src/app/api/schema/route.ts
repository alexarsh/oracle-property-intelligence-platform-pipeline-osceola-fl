/**
 * `GET /api/schema?table=properties|permits` — column list from the MCP schema tools.
 *
 * @module api/schema
 */
import { NextResponse } from "next/server";
import { errorResponse, jsonError } from "../_lib";
import { createMcpClient } from "@/lib/mcp/client";
import { getPermitSchema, getPropertySchema } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const table = new URL(req.url).searchParams.get("table") ?? "properties";
  if (table !== "properties" && table !== "permits")
    return jsonError("table must be properties or permits");
  try {
    const mcp = createMcpClient();
    const schema =
      table === "properties" ? await getPropertySchema(mcp) : await getPermitSchema(mcp);
    return NextResponse.json(schema);
  } catch (err) {
    return errorResponse(err);
  }
}
