#!/usr/bin/env bash
# Deploy (or redeploy) a copy of the stock Elephant MCP server on Vercel, pointed
# at one published Osceola run. Usage:
#
#   ./mcp/deploy.sh <runId> [--prod]
#
# Reads artifacts/runs/<runId>/manifest.json for the run root CID, derives the
# Filebase gateway URLs of the query tables (DuckDB httpfs needs Range support),
# clones @elephant-xyz/mcp at the pinned commit into .cache/, sets the project
# env vars, and deploys. Requires `vercel` CLI logged in (`npx vercel login`).
#
# The CID — not the gateway hostname — is the artifact identity; the same bytes
# are retrievable from https://ipfs.io/ipfs/<cid> and https://dweb.link/ipfs/<cid>.
set -euo pipefail

RUN_ID="${1:?usage: mcp/deploy.sh <runId> [--prod]}"
PROD_FLAG="${2:-}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT_DIR/artifacts/runs/$RUN_ID/manifest.json"
ELEPHANT_MCP_REPO="https://github.com/elephant-xyz/elephant-mcp"
ELEPHANT_MCP_COMMIT="${ELEPHANT_MCP_COMMIT:-aad2785d700fb14e69872dd55f4b8e06acd09806}"
GATEWAY="${FILEBASE_GATEWAY:-https://ipfs.filebase.io}"
PROJECT="${MCP_VERCEL_PROJECT:-osceola-mcp}"
CACHE="$ROOT_DIR/.cache/elephant-mcp"

[ -f "$MANIFEST" ] || { echo "manifest not found: $MANIFEST" >&2; exit 1; }
ROOT_CID="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).root.cid)")"
echo "run $RUN_ID root CID: $ROOT_CID"

PROPERTY_MAP="{\"osceola\":\"$GATEWAY/ipfs/$ROOT_CID/query-tables/properties.parquet\"}"
PERMIT_MAP="{\"osceola\":\"$GATEWAY/ipfs/$ROOT_CID/query-tables/permits.parquet\"}"
COVERAGE_MAP="{\"osceola\":\"$GATEWAY/ipfs/$ROOT_CID/coverage.json\"}"

if [ ! -d "$CACHE/.git" ]; then
  git clone --quiet "$ELEPHANT_MCP_REPO" "$CACHE"
fi
git -C "$CACHE" fetch --quiet origin
git -C "$CACHE" checkout --quiet "$ELEPHANT_MCP_COMMIT"

cd "$CACHE"
npm install --no-audit --no-fund >/dev/null

# Link (or create) the Vercel project non-interactively, then set env vars for all targets.
vercel link --yes --project "$PROJECT" >/dev/null
for TARGET in production preview development; do
  for KV in "PROPERTY_QUERY_TABLE_MAP=$PROPERTY_MAP" "PERMIT_QUERY_TABLE_MAP=$PERMIT_MAP" "DATASET_COVERAGE_MAP=$COVERAGE_MAP" \
            "PROPERTY_QUERY_TABLE_DEFAULT_COUNTY=osceola" "PERMIT_QUERY_TABLE_DEFAULT_COUNTY=osceola" "DATASET_COVERAGE_DEFAULT_COUNTY=osceola" \
            "OSCEOLA_RUN_ID=$RUN_ID" "OSCEOLA_RUN_ROOT_CID=$ROOT_CID"; do
    KEY="${KV%%=*}"; VAL="${KV#*=}"
    vercel env rm "$KEY" "$TARGET" --yes >/dev/null 2>&1 || true
    printf '%s' "$VAL" | vercel env add "$KEY" "$TARGET" >/dev/null
  done
done

if [ "$PROD_FLAG" = "--prod" ]; then
  vercel deploy --prod --yes
else
  vercel deploy --yes
fi
