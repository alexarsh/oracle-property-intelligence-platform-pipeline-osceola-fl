import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chainStatus, findArtifactsDir, loadArtifacts, runIdToIso, toIso } from "./artifacts";
import type { RunBundle } from "./artifacts";

const CID_A = "bafybeiai4v6n7xxryf7rkmemqs3cnjew3hlkm5ov4zs2prbrbcodxwoiiu";
const CID_B = "bafybeih2chewz4rqs7ohhmyhruavvpji23xgda27q5efyfc5xlt6ogzj7a";
const DIGEST = "sha256:6c2be89522c528ec4c5dcabd6c5193faa2718bda2c70745a25e0a3da1b995bf1";

function manifest(runId: string, rootCid: string, previous: string | null) {
  return {
    schemaVersion: "1.0",
    county: "osceola",
    countyFips: "12097",
    runId,
    publishedAt: "2026-09-07T09:04:03.465Z",
    root: {
      name: "",
      cid: rootCid,
      size: 10,
      codec: "directory",
      digest: DIGEST,
      mediaType: null,
      rowCount: null,
      origins: [],
    },
    car: { fileName: "run.car", size: 12, digest: DIGEST, cid: null },
    artifacts: [
      {
        name: "query-tables/properties.parquet",
        cid: CID_B,
        size: 5,
        codec: "file",
        digest: DIGEST,
        mediaType: "application/vnd.apache.parquet",
        rowCount: 210853,
        origins: [],
      },
      {
        name: "coverage.json",
        cid: CID_B,
        size: 5,
        codec: "file",
        digest: DIGEST,
        mediaType: "application/json",
        rowCount: null,
        origins: [],
      },
    ],
    ipns: null,
    previousRootCid: previous,
    gateways: ["https://ipfs.io", "https://dweb.link"],
  };
}

const coverage = {
  county: "osceola",
  runId: "2026-09-07T00-00-00Z-full",
  exportedAt: "2026-09-07T09:04:01.825Z",
  datasets: [
    {
      county: "osceola",
      source: "osceola_appraiser",
      ingested_count: 3,
      first_loaded_at: "2026-09-07 08:51:42.781",
      last_loaded_at: "2026-09-07 08:51:42.781",
    },
  ],
  tables: [
    {
      table: "permits",
      rows: 317197,
      columns: [{ column: "permit_number", nonNull: 317197, pct: 100 }],
    },
  ],
  sourceLoads: [
    {
      run_id: "2026-09-07T00-00-00Z-full",
      source: "ocpa_certified",
      item: "vw_mdparcel.csv",
      url: "https://www.property-appraiser.org/data/x.zip",
      digest: "ab",
      bytes: 10,
      rows: 210853,
      fetched_at: "2026-09-07 08:51:42.781",
      notes: null,
    },
    {
      run_id: "2026-09-07T00-00-00Z-full",
      source: "ocpa_certified",
      item: "vw_permits.csv",
      url: "https://www.property-appraiser.org/data/x.zip",
      digest: "cd",
      bytes: 10,
      rows: 317197,
      fetched_at: "2026-09-07 08:52:00.000",
      notes: null,
    },
  ],
};

async function scaffold(withHistory: boolean): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "osceola-artifacts-"));
  const run = path.join(root, "artifacts", "runs", "2026-09-07T00-00-00Z-full");
  await mkdir(run, { recursive: true });
  await writeFile(
    path.join(run, "manifest.json"),
    JSON.stringify(manifest("2026-09-07T00-00-00Z-full", CID_A, null)),
  );
  await writeFile(path.join(run, "coverage.json"), JSON.stringify(coverage));
  if (withHistory) {
    await writeFile(
      path.join(root, "artifacts", "run-history.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        county: "osceola",
        runs: [
          {
            runId: "2026-09-07T00-00-00Z-full",
            county: "osceola",
            mode: "full",
            startedAt: "2026-09-07T00:00:00Z",
            finishedAt: "2026-09-07T09:04:03.465Z",
            status: "succeeded",
            pipelineCommit: "abc",
            sources: [],
            tableCounts: { properties: 210853 },
            tableDeltas: { properties: 210853 },
            manifestCid: null,
            rootCid: CID_A,
            previousRootCid: null,
            ipnsName: null,
            verification: null,
            notes: [],
          },
        ],
      }),
    );
  }
  // a nested cwd two levels below the repo root, like apps/explorer
  const cwd = path.join(root, "apps", "explorer");
  await mkdir(cwd, { recursive: true });
  return cwd;
}

describe("findArtifactsDir", () => {
  it("walks up from apps/explorer to <root>/artifacts", async () => {
    const cwd = await scaffold(false);
    expect(await findArtifactsDir(cwd)).toBe(path.resolve(cwd, "../../artifacts"));
  });
  it("returns null when nothing is found", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "osceola-empty-"));
    expect(await findArtifactsDir(empty)).toBeNull();
  });
});

describe("loadArtifacts", () => {
  it("uses run-history.json as the only source of run records", async () => {
    const snap = await loadArtifacts(await scaffold(true));
    expect(snap.history?.runs).toHaveLength(1);
    expect(snap.runs).toHaveLength(1);
    expect(snap.latest?.record.rootCid).toBe(CID_A);
    expect(snap.latestPublished?.runId).toBe("2026-09-07T00-00-00Z-full");
    expect(snap.latest?.manifest?.artifacts).toHaveLength(2);
    expect(snap.latest?.coverage?.tables[0]?.table).toBe("permits");
    expect(snap.warnings).toEqual([]);
  });
  it("shows no runs (and a warning) when history is missing, even if run directories exist", async () => {
    const snap = await loadArtifacts(await scaffold(false));
    expect(snap.history).toBeNull();
    expect(snap.runs).toEqual([]);
    expect(snap.latest).toBeNull();
    expect(snap.warnings.some((w) => w.includes("run-history.json is missing"))).toBe(true);
  });
});

describe("chainStatus", () => {
  const rec = (
    runId: string,
    rootCid: string | null,
    previousRootCid: string | null,
    status: "succeeded" | "running" = "succeeded",
  ): RunBundle => ({
    runId,
    record: {
      runId,
      county: "osceola",
      mode: "incremental",
      startedAt: runId,
      finishedAt: null,
      status,
      pipelineCommit: null,
      sources: [],
      tableCounts: {},
      tableDeltas: {},
      manifestCid: null,
      rootCid,
      previousRootCid,
      ipnsName: null,
      verification: null,
      notes: [],
    },
    manifest: null,
    coverage: null,
    verification: null,
  });
  it("links each run to the most recent published root before it (newest first)", () => {
    const runs = [rec("3", null, CID_B, "running"), rec("2", CID_B, CID_A), rec("1", CID_A, null)];
    expect(chainStatus(runs, 2)).toBe("first");
    expect(chainStatus(runs, 1)).toBe("linked");
    expect(chainStatus(runs, 0)).toBe("linked");
  });
  it("flags a broken chain and pending runs", () => {
    expect(
      chainStatus(
        [
          rec("2", CID_B, "bafybeigi53fqrhhlk6eqeuirw3k23s5ebqbejmhl6zggbqut7e4u25wwdy"),
          rec("1", CID_A, null),
        ],
        0,
      ),
    ).toBe("broken");
    expect(chainStatus([rec("2", null, null, "running"), rec("1", CID_A, null)], 0)).toBe(
      "pending",
    );
    expect(chainStatus([rec("1", CID_A, CID_B)], 0)).toBe("broken");
  });
});

describe("helpers", () => {
  it("converts run ids and DuckDB timestamps to ISO", () => {
    expect(runIdToIso("2026-09-07T00-00-00Z-full")).toBe("2026-09-07T00:00:00Z");
    expect(runIdToIso("nope")).toBeNull();
    expect(toIso("2026-09-07 08:51:42.781")).toBe("2026-09-07T08:51:42.781Z");
    expect(toIso("2026-09-07T08:51:42.781Z")).toBe("2026-09-07T08:51:42.781Z");
    expect(toIso("2026-09-07T09:07:42.209")).toBe("2026-09-07T09:07:42.209Z");
    expect(toIso("2026-09-07T09:07:42+02:00")).toBe("2026-09-07T09:07:42+02:00");
  });
});
