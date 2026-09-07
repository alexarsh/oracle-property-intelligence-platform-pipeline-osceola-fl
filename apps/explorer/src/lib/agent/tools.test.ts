import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { McpDataClient } from "../mcp/client";
import { createLeadAgent } from "./agent";
import { createAgentTools } from "./tools";

const SCHEMA = {
  county: "osceola",
  view: "properties",
  columnCount: 2,
  columns: [
    { name: "parcel_identifier", type: "VARCHAR", description: "Parcel" },
    { name: "roof_age_years", type: "INTEGER", description: null },
  ],
  nullabilityNote: "note",
  safetyNote: "safe",
};

function fakeMcp(): McpDataClient & {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    listTools: () => Promise.resolve([]),
    callToolJson(name, args) {
      calls.push({ name, args });
      switch (name) {
        case "getPropertyQuerySchema":
          return Promise.resolve(SCHEMA);
        case "getPermitQuerySchema":
          return Promise.resolve({ ...SCHEMA, view: "permits" });
        case "queryProperties":
          return Promise.resolve({
            county: "osceola",
            rowCount: 1,
            limit: 100,
            rows: [{ parcel_identifier: "1", roof_age_years: "17" }],
          });
        case "queryPermits":
          return Promise.resolve({ county: "osceola", rowCount: 0, limit: 100, rows: [] });
        case "findPropertiesInArea":
          return Promise.resolve({
            count: 1,
            parcels: [{ parcelIdentifier: "1", latitude: 28.29, longitude: -81.4 }],
          });
        default:
          return Promise.reject(new Error(`unexpected tool ${name}`));
      }
    },
  };
}

describe("agent tools", () => {
  it("getSchema calls the MCP schema tool for the requested view", async () => {
    const mcp = fakeMcp();
    const tools = createAgentTools(mcp);
    const out = await tools.getSchema.execute!(
      { table: "permits" },
      { toolCallId: "t1", messages: [] },
    );
    expect(out).toMatchObject({ view: "permits", columnCount: 2 });
    expect(mcp.calls).toEqual([{ name: "getPermitQuerySchema", args: { county: "osceola" } }]);
  });

  it("queryProperties forwards a single SELECT with county and cap, and rejects mutations", async () => {
    const mcp = fakeMcp();
    const tools = createAgentTools(mcp);
    const out = await tools.queryProperties.execute!(
      { sql: "SELECT parcel_identifier FROM properties LIMIT 5;" },
      { toolCallId: "t2", messages: [] },
    );
    expect(out).toMatchObject({
      view: "properties",
      rowCount: 1,
      sql: "SELECT parcel_identifier FROM properties LIMIT 5",
    });
    expect(mcp.calls[0]).toEqual({
      name: "queryProperties",
      args: {
        county: "osceola",
        sql: "SELECT parcel_identifier FROM properties LIMIT 5",
        limit: 100,
      },
    });
    await expect(
      tools.queryProperties.execute!(
        { sql: "DELETE FROM properties" },
        { toolCallId: "t3", messages: [] },
      ),
    ).rejects.toThrow(/only a single SELECT/);
    await expect(
      tools.queryPermits.execute!(
        { sql: "SELECT 1; SELECT 2" },
        { toolCallId: "t4", messages: [] },
      ),
    ).rejects.toThrow(/multiple/);
  });

  it("geocodePlace resolves offline and returns a haversine template", async () => {
    const tools = createAgentTools(fakeMcp());
    const hit = await tools.geocodePlace.execute!(
      { place: "Kissimmee" },
      { toolCallId: "t5", messages: [] },
    );
    expect(hit).toMatchObject({ found: true, name: "Kissimmee", lat: 28.2919, lng: -81.4076 });
    expect((hit as { radiusSqlTemplate: string }).radiusSqlTemplate).toContain("<= <miles>");
    const miss = await tools.geocodePlace.execute!(
      { place: "Atlantis" },
      { toolCallId: "t6", messages: [] },
    );
    expect(miss).toMatchObject({ found: false });
  });

  it("findPropertiesInArea passes the county and bbox to the MCP", async () => {
    const mcp = fakeMcp();
    const tools = createAgentTools(mcp);
    const bbox = { minLat: 28.28, maxLat: 28.3, minLng: -81.42, maxLng: -81.4 };
    const out = await tools.findPropertiesInArea.execute!(
      { bbox },
      { toolCallId: "t7", messages: [] },
    );
    expect(out).toMatchObject({ count: 1, truncated: false });
    expect(mcp.calls[0]).toEqual({
      name: "findPropertiesInArea",
      args: { county: "osceola", bbox },
    });
  });
});

describe("createLeadAgent with a mock model", () => {
  it("runs the tool loop: model → tool (MCP) → model answer", async () => {
    const mcp = fakeMcp();
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: vi.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "queryProperties",
                input: JSON.stringify({
                  sql: "SELECT parcel_identifier, roof_age_years FROM properties LIMIT 1",
                }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: 5, reasoning: undefined },
              raw: undefined,
            },
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "1 property matched (parcel 1, roof age 17)." }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
            raw: undefined,
          },
          warnings: [],
        };
      }),
      doStream: vi.fn().mockResolvedValue({ stream: simulateReadableStream({ chunks: [] }) }),
    });
    const agent = createLeadAgent({ mcp, model, maxSteps: 3 });
    const result = await agent.generate({ prompt: "How old is the roof on parcel 1?" });
    expect(result.text).toContain("1 property matched");
    expect(result.steps.length).toBe(2);
    expect(mcp.calls).toEqual([
      {
        name: "queryProperties",
        args: {
          county: "osceola",
          sql: "SELECT parcel_identifier, roof_age_years FROM properties LIMIT 1",
          limit: 100,
        },
      },
    ]);
    const toolResults = result.steps[0]!.toolResults;
    expect(toolResults[0]).toMatchObject({ toolName: "queryProperties", output: { rowCount: 1 } });
  });
});
