# MCP layer — the stock Elephant MCP over the published Osceola tables

The pipeline does **not** ship a bespoke MCP server. It publishes Parquet query
tables whose columns are the soofi-xyz kit's query-table schema (plus roofing
extensions), so the kit's own open-data server, [`@elephant-xyz/mcp`](https://github.com/elephant-xyz/elephant-mcp),
serves Osceola exactly the way it serves Lee, Orange or Polk: DuckDB range-reads
the Parquet straight from an IPFS gateway, and the `donphan` agent (or any MCP
client) gets `queryProperties`, `queryPermits`, `findPropertiesInArea`,
`getPropertyQuerySchema`, `getPermitQuerySchema`, `getPermitCoverage`, …

This is the kit's `deploy-open-data-mcp` skill applied to a new county: **every
consumer can run their own copy pointing at the same public CIDs.** There is no
shared backend and nothing for Oracle to host.

## What points where

| Env var (elephant-mcp)                                                      | Value                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `PROPERTY_QUERY_TABLE_MAP`                                                  | `{"osceola":"https://ipfs.filebase.io/ipfs/<runRootCid>/query-tables/properties.parquet"}` |
| `PERMIT_QUERY_TABLE_MAP`                                                    | `{"osceola":"https://ipfs.filebase.io/ipfs/<runRootCid>/query-tables/permits.parquet"}`    |
| `PROPERTY_QUERY_TABLE_DEFAULT_COUNTY` / `PERMIT_QUERY_TABLE_DEFAULT_COUNTY` | `osceola`                                                                                  |
| `DATASET_COVERAGE_MAP`                                                      | `{"osceola":"https://ipfs.filebase.io/ipfs/<runRootCid>/coverage.json"}`                   |
| `MCP_HTTP_AUTH_TOKEN`                                                       | optional bearer token for hosted deployments                                               |

`<runRootCid>` is the `root.cid` of the run's `manifest.json`
(`artifacts/runs/<runId>/manifest.json`). Pinning the MCP to a **run CID** (not
the IPNS name) makes the served snapshot immutable and auditable; a new run is
rolled out by updating the env and redeploying (`scripts/point-at-run.sh`).
The IPNS name `oracle-osceola-runs` always resolves to the latest run for
consumers who prefer "latest" semantics.

The Filebase gateway is used for the MCP because DuckDB's `httpfs` needs
reliable HTTP Range support (the kit documents the same choice); the artifact's
identity remains the CID, and the same bytes are retrievable from `ipfs.io` and
`dweb.link` (see `verification.json` per run).

## Deploy your own copy (Vercel, free tier)

```bash
./mcp/deploy.sh <runId>           # clones elephant-mcp at the pinned commit, sets env from the run manifest, deploys
```

or manually:

```bash
git clone https://github.com/elephant-xyz/elephant-mcp && cd elephant-mcp && git checkout aad2785d700fb14e69872dd55f4b8e06acd09806
npm install && npm run build
# local
MCP_HTTP_STANDALONE=1 PORT=8877 PROPERTY_QUERY_TABLE_MAP='{"osceola":"https://ipfs.filebase.io/ipfs/<runRootCid>/query-tables/properties.parquet"}' \
  PERMIT_QUERY_TABLE_MAP='{"osceola":"https://ipfs.filebase.io/ipfs/<runRootCid>/query-tables/permits.parquet"}' \
  PROPERTY_QUERY_TABLE_DEFAULT_COUNTY=osceola PERMIT_QUERY_TABLE_DEFAULT_COUNTY=osceola node dist/server-http.js
# hosted
vercel env add PROPERTY_QUERY_TABLE_MAP production   # …etc, then
vercel deploy --prod
```

Endpoint: `POST https://<deployment>/mcp` (streamable HTTP). `GET /health` is public.

## Client snippets

Cursor / Claude Desktop (`mcp.json`):

```json
{
  "mcpServers": {
    "elephant-osceola": {
      "url": "https://<deployment>/mcp"
    }
  }
}
```

stdio without any deployment (reads IPFS directly):

```json
{
  "mcpServers": {
    "elephant-osceola": {
      "command": "npx",
      "args": ["-y", "@elephant-xyz/mcp@latest"],
      "env": {
        "PROPERTY_QUERY_TABLE_MAP": "{\"osceola\":\"https://ipfs.filebase.io/ipfs/<runRootCid>/query-tables/properties.parquet\"}",
        "PERMIT_QUERY_TABLE_MAP": "{\"osceola\":\"https://ipfs.filebase.io/ipfs/<runRootCid>/query-tables/permits.parquet\"}",
        "PROPERTY_QUERY_TABLE_DEFAULT_COUNTY": "osceola",
        "PERMIT_QUERY_TABLE_DEFAULT_COUNTY": "osceola"
      }
    }
  }
}
```

## Smoke test (what `donphan` does first)

```text
getPropertyQuerySchema { "county": "osceola" }
queryProperties { "county": "osceola", "sql": "SELECT count(*) AS n FROM properties WHERE roof_age_years >= 15" }
queryPermits    { "county": "osceola", "sql": "SELECT permit_number, days_open, contractor_name FROM permits WHERE is_roofing AND is_open ORDER BY days_open DESC LIMIT 5" }
```

`mcp/smoke.mjs` runs these against any endpoint: `node mcp/smoke.mjs https://<deployment>/mcp`.
