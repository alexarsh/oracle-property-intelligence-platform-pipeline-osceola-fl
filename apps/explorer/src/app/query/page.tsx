import { Notice, PageHeader } from "@/components/ui";
import { QueryConsole } from "@/components/QueryConsole";
import { mcpPublicUrl } from "@/lib/env";
import { createMcpClient } from "@/lib/mcp/client";
import { getPermitCoverage, getPermitSchema, getPropertySchema } from "@/lib/mcp/tools";
import type { PermitCoverage, QuerySchema } from "@/lib/mcp/tools";
import { EXAMPLE_QUERIES } from "@/lib/queries/examples";
import { loadArtifacts } from "@/lib/artifacts";

export const dynamic = "force-dynamic";

export default async function QueryPage() {
  const mcp = createMcpClient();
  let properties: QuerySchema | null = null;
  let permits: QuerySchema | null = null;
  let coverage: PermitCoverage | null = null;
  let error: string | null = null;
  try {
    [properties, permits, coverage] = await Promise.all([
      getPropertySchema(mcp),
      getPermitSchema(mcp),
      getPermitCoverage(mcp),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const snap = await loadArtifacts();
  const parquet =
    snap.latest?.manifest?.artifacts.filter(
      (a) => a.name.startsWith("query-tables/") && a.codec === "file",
    ) ?? [];

  return (
    <>
      <PageHeader
        title="DuckDB query console"
        transcript="Now I am opening the DuckDB-backed query layer."
      >
        <div className="text-right text-xs text-zinc-500">
          <div>
            MCP endpoint <span className="font-mono">{mcpPublicUrl()}</span>
          </div>
          <div>DuckDB embedded in the MCP process · reads Parquet · no hosted database</div>
        </div>
      </PageHeader>
      {error ? (
        <Notice tone="bad">
          Could not reach the Elephant MCP at <span className="font-mono">{mcpPublicUrl()}</span>:{" "}
          {error}. Start it locally (see the README) or set <code>ORACLE_MCP_URL</code>.
        </Notice>
      ) : null}
      <QueryConsole
        schemas={{ properties, permits }}
        coverage={coverage}
        examples={EXAMPLE_QUERIES}
        endpoint={mcpPublicUrl()}
        parquet={parquet.map((a) => ({
          name: a.name,
          cid: a.cid,
          rowCount: a.rowCount,
          size: a.size,
        }))}
      />
    </>
  );
}
