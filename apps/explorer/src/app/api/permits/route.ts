/**
 * `POST /api/permits` — open roofing permits within a radius, longest open first.
 *
 * @module api/permits
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, jsonError } from "../_lib";
import { OSCEOLA } from "@osceola/shared";
import { createMcpClient } from "@/lib/mcp/client";
import { radiusOpenRoofingPermits } from "@/lib/queries/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  minDaysOpen: z.number().min(0).nullable().optional(),
  requireContractor: z.boolean().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return jsonError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    const t0 = Date.now();
    const result = await radiusOpenRoofingPermits(createMcpClient(), parsed.data);
    return NextResponse.json({ ...result, ms: Date.now() - t0 });
  } catch (err) {
    return errorResponse(err);
  }
}
