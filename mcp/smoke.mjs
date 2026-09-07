#!/usr/bin/env node
/**
 * Smoke-test an Elephant MCP endpoint serving the Osceola query tables.
 *
 *   node mcp/smoke.mjs https://<deployment>/mcp [bearerToken]
 *
 * Exits non-zero if any call fails. Mirrors the first calls the kit's `donphan`
 * agent makes (schema first, then one read-only SELECT per table).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] ?? "http://localhost:8787/mcp";
const token = process.argv[3] ?? process.env.ORACLE_MCP_AUTH_TOKEN;
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
});
const client = new Client({ name: "osceola-mcp-smoke", version: "0.1.0" });
await client.connect(transport);

const text = (r) => r.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(r);
const call = async (name, args) => {
  const started = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const body = text(r);
  console.log(`\n== ${name} ${JSON.stringify(args)} (${Date.now() - started} ms)`);
  console.log(body.length > 1200 ? `${body.slice(0, 1200)}…` : body);
  if (r.isError) throw new Error(`${name} failed`);
  return body;
};

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));
await call("getPropertyQuerySchema", { county: "osceola" });
await call("queryProperties", {
  county: "osceola",
  sql: "SELECT count(*) AS properties, count(*) FILTER (WHERE roof_age_years >= 15) AS aged_roofs, count(latitude) AS geocoded FROM properties",
});
await call("queryPermits", {
  county: "osceola",
  sql: "SELECT source_system, count(*) AS n, count(*) FILTER (WHERE is_roofing) AS roofing, count(*) FILTER (WHERE is_roofing AND is_open) AS open_roofing FROM permits GROUP BY 1 ORDER BY 2 DESC",
});
await call("findPropertiesInArea", {
  county: "osceola",
  bbox: { minLat: 28.28, maxLat: 28.3, minLng: -81.42, maxLng: -81.4 },
});
await client.close();
console.log("\nOK");
