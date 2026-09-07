/**
 * `GET /api/property?parcel=<parcel_identifier>` — one property plus all its permits (drawer).
 *
 * @module api/property
 */
import { NextResponse } from "next/server";
import { errorResponse, jsonError } from "../_lib";
import { createMcpClient } from "@/lib/mcp/client";
import { propertyDetail } from "@/lib/queries/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const parcel = new URL(req.url).searchParams.get("parcel") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,64}$/.test(parcel))
    return jsonError("parcel must be a parcel identifier");
  try {
    const detail = await propertyDetail(createMcpClient(), parcel);
    if (!detail.property) return jsonError("parcel not found", 404);
    return NextResponse.json(detail);
  } catch (err) {
    return errorResponse(err);
  }
}
