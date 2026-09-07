# Demo script — Oracle pipeline, Osceola County, FL

Follows the assignment's Demo Transcript line by line. Placeholders in angle
brackets are filled from `artifacts/run-history.json` and the deployment URLs.

**Links used in the demo**

| What                     | Where                                                                   |
| ------------------------ | ----------------------------------------------------------------------- |
| Explorer UI              | `<EXPLORER_URL>`                                                        |
| Elephant MCP endpoint    | `<MCP_URL>/mcp` (health: `<MCP_URL>/health`)                            |
| Pull request             | https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-osceola-fl/pull/1 |
| Latest run manifest      | `artifacts/runs/<RUN_ID>/manifest.json`                                 |
| Run root CID             | `<ROOT_CID>` (previous run: `<PREV_ROOT_CID>`)                          |
| IPNS name (pointer)      | `<IPNS_NAME>` → resolves to `<ROOT_CID>`                                |

## 1. "I am opening the pipeline run summary"

Open `<EXPLORER_URL>/`.

Point out: run id, mode (full / incremental), started/finished, the **source
table** (rows seen / new / changed / quarantined, plus each source's
limitations verbatim), table counts with deltas, root CID, previous root CID,
IPNS + resolved CID, verification status, and the run-history table at the
bottom showing every earlier root CID unchanged.

## 2. "Show the total uploaded records by source"

Open `<EXPLORER_URL>/sources`.

Say the numbers out loud: properties (~210.9k), permits (~317k+ appraiser +
Accela portal), ownership rows, contractors, BBB-rated contractors,
coordinates (99.7%), Overture business locations. Scroll to the **source-load
ledger**: every file with URL, SHA-256, bytes, rows, fetched-at.

## 3. "Now I am opening the DuckDB-backed query layer"

Open `<EXPLORER_URL>/query`.

Run the first sample query. Explain: the SQL goes to the Elephant MCP, whose
embedded DuckDB range-reads the Parquet from IPFS. There is no database server;
Oracle hosts nothing but a stateless function.

## 4. "Show the published artifact manifest for this run"

Open `<EXPLORER_URL>/manifest`.

Point out per artifact: CID, logical name, size, codec, digest, row count; the
CAR entry; gateway links **derived** from the CID; IPNS name next to the
resolved CID. Optionally open the raw `manifest.json`.

## 5. "Retrieve one published artifact by CID from two independent gateways"

On the same page press **Verify now** on `coverage.json` for `ipfs.io`, then
for `dweb.link`. Both return bytes and a SHA-256 that match the manifest.
Then show `verification.json` (the automated proof recorded by the run,
including the large Parquet files).

Command-line alternative:

```bash
curl -sL https://ipfs.io/ipfs/<COVERAGE_CID> | shasum -a 256
curl -sL https://dweb.link/ipfs/<COVERAGE_CID> | shasum -a 256
# both equal the manifest digest
```

## 6. "A later incremental publish produced a new CID without mutating the previous one"

Back on `/` (or `/manifest` with the run selector): the newest run has root
`<ROOT_CID>`; the previous run's root `<PREV_ROOT_CID>` still resolves
(press Verify on an artifact of the previous run); IPNS now points at the new
root; both CIDs sit in run history; each run has a CAR.

## 7. "Properties within a sample radius with roofs older than 15 years"

Open `<EXPLORER_URL>/leads`, pick **Kissimmee**, radius 5 mi, threshold 15.
Results show roof-age basis (finaled roofing permit vs. year built),
coordinates, owner and mailing state, and source URLs per property.

## 8. "Open roofing permits, prioritizing long-open ones, with contractor and BBB"

Switch to the **Permits** tab, sort by days open. Open a permit: status, open
duration, contractor business + qualifier + license + phone, BBB rating when
matched, and the portal / export source link.

## 9. "The same questions through the agent"

Open `<EXPLORER_URL>/agent` and click the two prepared prompts:

- "Which properties in Osceola County within five miles of Kissimmee have roofs older than 15 years?"
- "Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?"

Show the tool calls and SQL inline, the source-backed answer, and the stated
assumptions / missing data (e.g. no BBB match for a contractor).

## 10. "The system is MCP-ready"

Open `<EXPLORER_URL>/mcp`: the endpoint, live `tools/list`, and the copy-paste
configs for Cursor / Claude Desktop / stdio. Mention that the CRM uses the
same endpoint and the same data model.

## Closing line

"Oracle carries no standing infrastructure: compute is a scheduled GitHub
Actions job, storage is content-addressed on IPFS, and serving is a stateless
MCP anyone can redeploy from the CIDs in this repository."
