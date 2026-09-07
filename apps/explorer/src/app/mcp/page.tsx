import { CopyBlock } from "@/components/CopyBlock";
import { Badge, ExtLink, KV, Notice, PageHeader, Section } from "@/components/ui";
import { loadArtifacts } from "@/lib/artifacts";
import { mcpAuthToken, mcpPublicUrl } from "@/lib/env";
import { GATEWAYS, gatewayUrl } from "@/lib/gateways";
import { createMcpClient } from "@/lib/mcp/client";
import type { McpToolInfo } from "@/lib/mcp/client";

export const dynamic = "force-dynamic";

const USED = new Set([
  "getPropertyQuerySchema",
  "queryProperties",
  "getPermitQuerySchema",
  "queryPermits",
  "getPermitCoverage",
  "findPropertiesInArea",
]);

export default async function McpPage() {
  const endpoint = mcpPublicUrl();
  let tools: McpToolInfo[] = [];
  let error: string | null = null;
  try {
    tools = await createMcpClient().listTools();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const snap = await loadArtifacts();
  const m = snap.latest?.manifest ?? null;
  const rootCid = m?.root.cid ?? "<root-cid>";
  const gw = GATEWAYS.filter((g) => g.independent);
  const propsUrl = gatewayUrl(gw[0]!, rootCid, "query-tables/properties.parquet");
  const permitsUrl = gatewayUrl(gw[0]!, rootCid, "query-tables/permits.parquet");
  const hasToken = mcpAuthToken() !== null;

  const httpConfig = JSON.stringify(
    {
      mcpServers: {
        elephant: {
          url: endpoint,
          ...(hasToken ? { headers: { Authorization: "Bearer <ORACLE_MCP_AUTH_TOKEN>" } } : {}),
        },
      },
    },
    null,
    2,
  );
  const stdioEnv = {
    PROPERTY_QUERY_TABLE_MAP: JSON.stringify({ osceola: propsUrl }),
    PERMIT_QUERY_TABLE_MAP: JSON.stringify({ osceola: permitsUrl }),
    PROPERTY_QUERY_TABLE_DEFAULT_COUNTY: "osceola",
    PERMIT_QUERY_TABLE_DEFAULT_COUNTY: "osceola",
  };
  const stdioConfig = JSON.stringify(
    {
      mcpServers: {
        elephant: { command: "npx", args: ["-y", "@elephant-xyz/mcp"], env: stdioEnv },
      },
    },
    null,
    2,
  );
  const claudeDesktop = JSON.stringify(
    {
      mcpServers: {
        "elephant-osceola": { command: "npx", args: ["-y", "@elephant-xyz/mcp"], env: stdioEnv },
      },
    },
    null,
    2,
  );
  const shell =
    `PROPERTY_QUERY_TABLE_MAP='${stdioEnv.PROPERTY_QUERY_TABLE_MAP}' \\\n` +
    `PERMIT_QUERY_TABLE_MAP='${stdioEnv.PERMIT_QUERY_TABLE_MAP}' \\\n` +
    `PROPERTY_QUERY_TABLE_DEFAULT_COUNTY=osceola PERMIT_QUERY_TABLE_DEFAULT_COUNTY=osceola \\\n` +
    `npx -y @elephant-xyz/mcp`;
  const curl =
    `curl -s ${endpoint} -H 'content-type: application/json' -H 'accept: application/json, text/event-stream'` +
    (hasToken ? " -H 'authorization: Bearer $ORACLE_MCP_AUTH_TOKEN'" : "") +
    ` \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"queryProperties","arguments":{"county":"osceola","sql":"SELECT count(*) AS aged_roofs FROM properties WHERE roof_age_years >= 15"}}}'`;

  return (
    <>
      <PageHeader title="MCP-ready" transcript="Finally, I will show that the system is MCP-ready.">
        <div className="text-right text-xs text-zinc-500">
          <div>stock @elephant-xyz/mcp · streamable HTTP · DuckDB over Parquet</div>
        </div>
      </PageHeader>

      <div className="card mb-6">
        <KV
          rows={[
            [
              "Endpoint",
              <span key="e" className="font-mono">
                {endpoint}
              </span>,
            ],
            [
              "Auth",
              hasToken
                ? "Bearer token (ORACLE_MCP_AUTH_TOKEN) forwarded by this explorer"
                : "none configured",
            ],
            [
              "Status",
              error ? (
                <Badge key="s" tone="bad">
                  unreachable
                </Badge>
              ) : (
                <Badge key="s" tone="ok">
                  {tools.length} tools listed live
                </Badge>
              ),
            ],
            ["County key", <code key="c">osceola</code>],
            [
              "Data model",
              "Kit query tables (properties, permits) served unchanged — the roofing CRM and any MCP client query the same views with the same tools.",
            ],
            [
              "Data location",
              m ? (
                <span key="d">
                  IPFS root <span className="mono">{m.root.cid}</span> — the MCP can open the
                  Parquet from any gateway URL derived from that CID; no copy of the data is hosted
                  by this app.
                </span>
              ) : (
                "manifest not found"
              ),
            ],
          ]}
        />
      </div>

      {error ? <Notice tone="bad">tools/list failed: {error}</Notice> : null}

      <Section
        title="tools/list (live)"
        description="Fetched from the endpoint on every page load. The six tools the explorer itself uses are highlighted; the rest are the stock server's lexicon/open-data tools."
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Description</th>
                <th>Input</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <tr
                  key={t.name}
                  className={USED.has(t.name) ? "bg-emerald-50/60 dark:bg-emerald-950/20" : ""}
                >
                  <td className="font-mono text-xs whitespace-nowrap">
                    {t.name} {USED.has(t.name) ? <Badge tone="ok">used</Badge> : null}
                  </td>
                  <td className="max-w-xl text-xs">{t.description ?? ""}</td>
                  <td className="text-xs text-zinc-500">{summarizeSchema(t.inputSchema)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Client configurations"
        description="Copy-paste. HTTP configs point at the hosted endpoint; stdio configs run the published npm package locally and read the Parquet straight from an IPFS gateway URL derived from the current run's root CID."
      >
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <CopyBlock label="Cursor — .cursor/mcp.json (hosted HTTP endpoint)" text={httpConfig} />
          <CopyBlock
            label="Cursor — .cursor/mcp.json (stdio, Parquet from IPFS)"
            text={stdioConfig}
          />
          <CopyBlock label="Claude Desktop — claude_desktop_config.json" text={claudeDesktop} />
          <CopyBlock label="Shell — run the server yourself" text={shell} />
          <CopyBlock label="curl — raw JSON-RPC tools/call" text={curl} className="xl:col-span-2" />
        </div>
      </Section>

      <Section title="Contract" description="What a client can rely on.">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            <code>getPropertyQuerySchema {"{county}"}</code> /{" "}
            <code>getPermitQuerySchema {"{county}"}</code> — column lists of the{" "}
            <code>properties</code> and <code>permits</code> views (kit columns + roofing-lead
            extensions).
          </li>
          <li>
            <code>queryProperties {"{county, sql, limit?}"}</code> /{" "}
            <code>queryPermits {"{county, sql}"}</code> — one read-only SELECT, rows capped at
            1,000.
          </li>
          <li>
            <code>findPropertiesInArea {"{county, bbox|polygon}"}</code> — parcels by centroid;{" "}
            <code>getPermitCoverage {"{county}"}</code> — permit counts by source.
          </li>
          <li>
            Radius search is plain SQL: the haversine over latitude/longitude in miles (see the
            Query page examples).
          </li>
          <li>
            Snapshots are immutable: point the maps at a new run's root CID to move forward, or at
            an old one to reproduce a past answer. Manifest links:{" "}
            {gw.map((g) => (
              <span key={g.key}>
                <ExtLink href={gatewayUrl(g, rootCid, "manifest.json")}>{g.label}</ExtLink>{" "}
              </span>
            ))}
          </li>
        </ul>
      </Section>
    </>
  );
}

function summarizeSchema(schema: unknown): string {
  if (typeof schema !== "object" || schema === null) return "";
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  const required = new Set((schema as { required?: string[] }).required ?? []);
  if (!props) return "";
  return Object.keys(props)
    .map((k) => (required.has(k) ? k : `${k}?`))
    .join(", ");
}
