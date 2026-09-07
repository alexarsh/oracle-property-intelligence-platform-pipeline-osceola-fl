# @osceola/explorer — Osceola Oracle Explorer

Next.js 15 (App Router, TypeScript strict, Tailwind v4) UI for the Osceola County, FL Oracle pipeline. It makes every line of the assignment's demo transcript demonstrable in a browser:

| Route       | Demo line                                                                                                                                  | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`         | "I am opening the pipeline run summary"                                                                                                    | Latest run from `artifacts/run-history.json` (or derived from `manifest.json` until history exists): id, mode, timestamps, per-source seen/new/changed/quarantined with limitations verbatim, table counts + deltas, root/previous root CID, IPNS + resolved CID, verification status, and the full run-history table (immutable CID chain).                                                                                                                                  |
| `/sources`  | "Show the total uploaded records by source"                                                                                                | `coverage.json`: property / permit / ownership / contractor (BBB) / coordinate counts, dataset ledger with timestamps, source catalog with limitations, source-load ledger (url, sha256, bytes, rows, fetched_at), per-column non-null coverage bars. Gaps (e.g. BBB empty) are stated plainly.                                                                                                                                                                               |
| `/manifest` | "Show the published artifact manifest" / "Retrieve one artifact by CID from two independent gateways" / "later publish produced a new CID" | Every artifact with CID, name, size, codec, digest, row count; gateway links **derived** from the CID (ipfs.io, dweb.link, Filebase); **Verify now** buttons call `/api/verify`, which streams the bytes server-side, SHA-256s them and reports match/bytes/ms; directory-root proof via path resolution; CAR entry with import instructions; last `verification.json`; raw manifest. Run selector for older runs.                                                            |
| `/query`    | "I am opening the DuckDB-backed query layer"                                                                                               | Schema browser (`getPropertyQuerySchema` / `getPermitQuerySchema`), SQL console (`queryProperties` / `queryPermits`), permit coverage, demo example queries (aged roofs in radius, long-open roofing permits with contractor + BBB, no sale in 10y, out-of-state owners), results grid, CSV download, SQL as executed.                                                                                                                                                        |
| `/leads`    | "Using the UI, show properties within a sample radius with roofs older than 15 years" / "open roofing permits … contractor and BBB"        | MapLibre + OSM tiles, demo places or click-to-drop pin, radius 1–15 mi, roof-age threshold, open-permit / open > N years / out-of-state / no-sale filters, total match count + nearest 500 markers, an "open roofing permits in radius" table (longest open first, contractor/license/phone/BBB/source), and a property drawer with roof-age basis, coordinates, owner/mailing, last sale, source URLs and every permit on the parcel. SQL sent to the MCP is one click away. |
| `/agent`    | "Now I am asking the same questions through the agent"                                                                                     | Vercel AI SDK `ToolLoopAgent` on Anthropic (`claude-sonnet-4-5`, override with `AGENT_MODEL`) with Zod tools `getSchema`, `geocodePlace`, `queryProperties`, `queryPermits`, `findPropertiesInArea`. Tool calls and SQL are rendered inline; the two transcript prompts are one-click suggestions. Without `ANTHROPIC_API_KEY` the page shows a notice instead of failing.                                                                                                    |
| `/mcp`      | "Finally, I will show that the system is MCP-ready"                                                                                        | Configured endpoint, live `tools/list`, copy-paste Cursor / Claude Desktop / shell / curl configs (HTTP endpoint or `npx @elephant-xyz/mcp` stdio reading the Parquet straight from an IPFS gateway URL derived from the current root CID).                                                                                                                                                                                                                                   |

## Data access: only through the Elephant MCP

Every data read — server components, route handlers and agent tools — is an MCP tool call to the stock [`@elephant-xyz/mcp`](https://github.com/elephant-xyz/elephant-mcp) server (streamable HTTP), which embeds DuckDB and reads the pipeline's published Parquet. The app never opens Parquet or DuckDB itself, so what the UI shows is exactly what any external agent or the roofing CRM gets through the same tools and the same kit data model.

- `src/lib/mcp/client.ts` — minimal client (`callToolJson`, `listTools`), bearer token support.
- `src/lib/mcp/tools.ts` — typed wrappers: `getPropertySchema`, `getPermitSchema`, `queryProperties`, `queryPermits`, `getPermitCoverage`, `findPropertiesInArea` (+ Zod result schemas and BIGINT-string coercion).
- `src/lib/mcp/sql.ts` — SQL builders: column whitelist from `@osceola/shared`, numeric/enum-only interpolation, validated parcel ids, escaped `ILIKE`, haversine radius expression, bbox pre-filter, single-SELECT guard. Tested in `sql.test.ts`.
- `src/lib/queries/leads.ts` — named lead queries (`radiusLeads`, `radiusOpenRoofingPermits`, `propertyDetail`) with typed rows.
- `src/lib/agent/*` — offline gazetteer, agent tools, `ToolLoopAgent` factory and Donphan-style system prompt.
- `src/lib/artifacts.ts` — `fs` loaders for `run-history.json`, `manifest.json`, `coverage.json`, `verification.json` (walks up from cwd or `OSCEOLA_ARTIFACTS_DIR`; derives a run record when history is missing).

Radius search is plain SQL: `3958.8*2*asin(sqrt(pow(sin(radians(latitude-LAT)/2),2)+cos(radians(LAT))*cos(radians(latitude))*pow(sin(radians(longitude-LNG)/2),2))) <= miles`.

## Run locally

```bash
# 1. MCP over the current run's Parquet (from the elephant-mcp checkout)
R=/path/to/osceola/artifacts/runs/<runId>/query-tables
MCP_HTTP_STANDALONE=1 PORT=8877 \
PROPERTY_QUERY_TABLE_MAP="{\"osceola\":\"$R/properties.parquet\"}" \
PERMIT_QUERY_TABLE_MAP="{\"osceola\":\"$R/permits.parquet\"}" \
PROPERTY_QUERY_TABLE_DEFAULT_COUNTY=osceola PERMIT_QUERY_TABLE_DEFAULT_COUNTY=osceola \
node dist/server-http.js

# 2. Explorer (repo root)
npx tsc -b packages/shared            # if packages/shared/dist is missing
ORACLE_MCP_URL=http://localhost:8877/mcp npm run dev --workspace @osceola/explorer   # http://localhost:3100
```

Checks: `npx tsc --noEmit -p apps/explorer`, `npm run lint`, `npx vitest run apps/explorer`, `npm run build --workspace @osceola/explorer`.

## Environment variables

| Variable                     | Required                                  | Purpose                                                                              |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `ORACLE_MCP_URL`             | yes (default `http://localhost:8877/mcp`) | Streamable-HTTP endpoint of the Elephant MCP serving the Osceola Parquet.            |
| `ORACLE_MCP_AUTH_TOKEN`      | no                                        | Sent as `Authorization: Bearer …` (pairs with the server's `MCP_HTTP_AUTH_TOKEN`).   |
| `ANTHROPIC_API_KEY`          | for `/agent` only                         | Anthropic key used by `@ai-sdk/anthropic`. Absent ⇒ agent page shows a notice.       |
| `AGENT_MODEL`                | no (default `claude-sonnet-4-5`)          | Model id override.                                                                   |
| `NEXT_PUBLIC_MCP_PUBLIC_URL` | no                                        | Public MCP URL to advertise on `/mcp` when it differs from `ORACLE_MCP_URL`.         |
| `OSCEOLA_ARTIFACTS_DIR`      | no                                        | Absolute path to `artifacts/` when auto-discovery (walk up from cwd) does not apply. |

## Deploy (Vercel Hobby)

- Project root directory: `apps/explorer`; "Include source files outside of the Root Directory" enabled (default). `vercel.json` sets the install/build commands to run from the monorepo root so `@osceola/shared` resolves from the workspace and is built first.
- `next.config.ts` sets `outputFileTracingRoot` to the monorepo root and `outputFileTracingIncludes` for `artifacts/run-history.json` and `artifacts/runs/**/*.json`, so the committed run records ship with the serverless functions. Parquet and CAR files are **not** bundled — they live on IPFS and are read by the MCP.
- `/api/verify` and `/api/chat` declare `maxDuration = 300` (Hobby with Fluid compute). Large Parquet verification through public gateways can still exceed a gateway's own timeout; the UI reports the HTTP status instead of pretending.
- The MCP itself is hosted separately (same `@elephant-xyz/mcp` package; e.g. its Vercel/Nitro preset or any Node host) with `PROPERTY_QUERY_TABLE_MAP` / `PERMIT_QUERY_TABLE_MAP` pointing at gateway URLs derived from the run's root CID.

## Kit conformance

Follows the soofi-xyz team kit where it applies and documents the deviations:

- **Metagross / `build-frontend-backends`** — the kit prescribes a Turborepo monorepo, tRPC on Lambda behind API Gateway (CDK) and Amplify hosting. This milestone keeps the npm-workspaces monorepo and the shared-package rule (`@osceola/shared` holds every contract), but **deviates on hosting**: the assignment requires Oracle to carry zero standing infrastructure cost and no AWS account is available, so the explorer is a self-contained Next.js app deployed to **Vercel Hobby** (free tier, scale-to-zero) and its API surface is Next.js route handlers rather than a tRPC Lambda. There is no database to provision: the only backend is the stock Elephant MCP reading Parquet from IPFS. If the kit's AWS path becomes available, the `lib/` layer (MCP client, SQL builders, lead queries, agent) is framework-agnostic and can move behind a tRPC router unchanged.
- **Donphan / `use-elephant-mcp`** — all data reads go through MCP tools only (no IPFS CLI, no direct Parquet/DuckDB, no ad-hoc HTTP to data). `county` is passed on every call. The agent follows the playbook: restate scope, schema before SQL, one read-only SELECT, capped rows, methodology and source URLs, "not available" instead of invented values.
- **`stack-ai-sdk-for-llm`** — LLM calls use the Vercel AI SDK (`ai` v6 `ToolLoopAgent`, `@ai-sdk/anthropic`), Zod tool schemas, strict TypeScript, no `any`, no provider SDK. Tool execution is unit-tested with `MockLanguageModelV3` from `ai/test` (the v6 counterpart of `MockLanguageModelV2`).
- **Testing** — vitest tests live in `src/**/*.test.ts` and run from the repo root (`npm test`).
