/**
 * Run history: the committed, append-only record of every pipeline run
 * (`artifacts/run-history.json`) plus per-run directories holding the
 * manifest, verification report and run summary.
 *
 * Previous runs' CIDs are never rewritten: a new run appends a new record with
 * its own root CID and keeps `previousRootCid`, so the chain of immutable
 * snapshots is visible in one file.
 *
 * @module runs/history
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { RunHistory, type RunRecord, type TableCounts } from "@osceola/shared";
import { ARTIFACTS_DIR, COUNTY, REPO_ROOT } from "../config.js";
import { exists, readJson, writeJson } from "../util/fs.js";

const execFileAsync = promisify(execFile);

export const HISTORY_PATH = path.join(ARTIFACTS_DIR, "run-history.json");

export function runDir(runId: string): string {
  return path.join(ARTIFACTS_DIR, "runs", runId);
}

export async function readHistory(): Promise<RunHistory> {
  if (!(await exists(HISTORY_PATH))) return { schemaVersion: "1.0", county: COUNTY.key, runs: [] };
  return RunHistory.parse(await readJson(HISTORY_PATH));
}

/** Insert or replace the record with the same runId, keeping chronological order. */
export async function upsertRun(record: RunRecord): Promise<RunHistory> {
  const history = await readHistory();
  const idx = history.runs.findIndex((r) => r.runId === record.runId);
  if (idx >= 0) history.runs[idx] = record;
  else history.runs.push(record);
  history.runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  await writeJson(HISTORY_PATH, history);
  return history;
}

/** Attach (or replace) the verification summary on an existing run record. */
export async function recordVerification(
  runId: string,
  v: { verifiedAt: string; gateways: string[]; artifacts: unknown[]; allMatched: boolean },
): Promise<void> {
  const history = await readHistory();
  const run = history.runs.find((r) => r.runId === runId);
  if (!run) return;
  run.verification = {
    verifiedAt: v.verifiedAt,
    gateways: v.gateways,
    artifactsChecked: v.artifacts.length,
    allMatched: v.allMatched,
  };
  await writeJson(HISTORY_PATH, history);
}

/** Latest run that finished successfully and published a root CID. */
export async function lastPublishedRun(): Promise<RunRecord | null> {
  const history = await readHistory();
  return [...history.runs].reverse().find((r) => r.status === "succeeded" && r.rootCid) ?? null;
}

/** Latest run of any status except the given one (for delta computation). */
export async function previousSuccessfulRun(excludeRunId: string): Promise<RunRecord | null> {
  const history = await readHistory();
  return (
    [...history.runs].reverse().find((r) => r.status === "succeeded" && r.runId !== excludeRunId) ??
    null
  );
}

export function tableDeltas(current: TableCounts, previous: TableCounts | null): TableCounts {
  const out: TableCounts = {};
  for (const [k, v] of Object.entries(current)) out[k] = v - (previous?.[k] ?? 0);
  return out;
}

/** Current git commit of the pipeline code (null outside a git checkout). */
export async function pipelineCommit(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return null;
  }
}
