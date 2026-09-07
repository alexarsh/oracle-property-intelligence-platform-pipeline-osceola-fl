import { describe, expect, it } from "vitest";
import type { McpDataClient } from "../mcp/client";
import { computeEnrichment, ENRICHMENT_BY_METHOD_SQL, ENRICHMENT_SQL } from "./enrichment";

function fake(
  rows: Record<string, unknown>[],
  byMethod: Record<string, unknown>[],
): McpDataClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listTools: () => Promise.resolve([]),
    callToolJson(name, args) {
      calls.push(`${name}:${String(args.sql)}`);
      const sql = String(args.sql);
      return Promise.resolve({
        county: "osceola",
        rowCount: 1,
        limit: 100,
        rows: sql === ENRICHMENT_BY_METHOD_SQL ? byMethod : rows,
      });
    },
  };
}

describe("computeEnrichment", () => {
  it("coerces BIGINT strings and groups rated contractors by match method", async () => {
    const mcp = fake(
      [
        {
          contractors: "4527",
          contractors_rated: "12",
          permits_with_contractor: "40944",
          permits_rated: "30",
          permits_accela: "1200",
          permits_total: "317197",
        },
      ],
      [
        { bbb_match_method: "license", contractors: "7" },
        { bbb_match_method: "name", contractors: "5" },
      ],
    );
    const s = await computeEnrichment(mcp);
    expect(s).toMatchObject({
      contractors: 4527,
      contractorsRated: 12,
      permitsWithContractor: 40944,
      permitsRated: 30,
      permitsAccela: 1200,
      permitsTotal: 317197,
      ratedByMethod: { license: 7, name: 5 },
    });
    expect(mcp.calls[0]).toBe(`queryPermits:${ENRICHMENT_SQL}`);
    expect(mcp.calls.every((c) => c.startsWith("queryPermits:"))).toBe(true);
  });
  it("returns honest zeros when nothing is enriched", async () => {
    const s = await computeEnrichment(
      fake(
        [
          {
            contractors: "0",
            contractors_rated: "0",
            permits_with_contractor: "0",
            permits_rated: "0",
            permits_accela: "0",
            permits_total: "0",
          },
        ],
        [],
      ),
    );
    expect(s.contractorsRated).toBe(0);
    expect(s.ratedByMethod).toEqual({});
  });
});
