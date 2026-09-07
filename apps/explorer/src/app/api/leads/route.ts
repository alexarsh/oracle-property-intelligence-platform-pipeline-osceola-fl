/**
 * `POST /api/leads` — radius lead search for the map.
 *
 * Body: `{ lat, lng, radiusMiles, minRoofAgeYears?, openRoofPermits?, openRoofPermitMinYears?,
 *          ownerOutOfState?, minYearsSinceSale?, propertyTypes?, ownerContains?, limit? }`
 *
 * Runs two MCP queries (properties in radius, then roofing permits on those
 * parcels) and returns typed rows plus the SQL that was executed.
 *
 * @module api/leads
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, jsonError } from "../_lib";
import { OSCEOLA } from "@osceola/shared";
import { createMcpClient } from "@/lib/mcp/client";
import { PROPERTY_TYPES } from "@/lib/mcp/sql";
import { radiusLeads } from "@/lib/queries/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  lat: z
    .number()
    .min(OSCEOLA.bbox.minLat - 0.5)
    .max(OSCEOLA.bbox.maxLat + 0.5),
  lng: z
    .number()
    .min(OSCEOLA.bbox.minLng - 0.5)
    .max(OSCEOLA.bbox.maxLng + 0.5),
  radiusMiles: z.number().min(0.1).max(15),
  minRoofAgeYears: z.number().int().min(0).max(150).nullable().optional(),
  openRoofPermits: z.boolean().optional(),
  openRoofPermitMinYears: z.number().min(0).max(60).nullable().optional(),
  ownerOutOfState: z.boolean().optional(),
  minYearsSinceSale: z.number().min(0).max(120).nullable().optional(),
  propertyTypes: z.array(z.enum(PROPERTY_TYPES)).optional(),
  ownerContains: z.string().max(120).nullable().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type LeadsRequest = z.infer<typeof Body>;

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return jsonError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    const t0 = Date.now();
    const result = await radiusLeads(createMcpClient(), parsed.data);
    return NextResponse.json({ ...result, ms: Date.now() - t0 });
  } catch (err) {
    return errorResponse(err);
  }
}
