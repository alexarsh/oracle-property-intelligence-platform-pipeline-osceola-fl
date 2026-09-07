/**
 * Assemble and persist the run manifest.
 *
 * Flow: pack the run directory into a CAR (computing every CID locally) ->
 * optionally upload + IPNS -> write `manifest.json` (outside the packed root,
 * because the manifest describes the root and therefore cannot be inside it)
 * -> optionally upload the manifest itself and record its CID in run history.
 *
 * @module publish/manifest
 */
import path from "node:path";
import { RunManifest, type ManifestArtifact } from "@osceola/shared";
import { COUNTY, FILEBASE, VERIFY_GATEWAYS, hasFilebaseCredentials } from "../config.js";
import { logger } from "../logger.js";
import { writeJson } from "../util/fs.js";
import { packDirectory, toManifestArtifact } from "./car.js";
import { uploadCar, upsertIpns } from "./filebase.js";

export interface PublishOptions {
  runId: string;
  /** Directory holding query-tables/, coverage.json, samples/ (the packed root). */
  runDir: string;
  /** Root CID of the previous published run, for the immutability chain. */
  previousRootCid: string | null;
  /** Row counts per query table for the manifest. */
  rowCounts: Record<string, number>;
  /** When false, pack + manifest only (no network). */
  live: boolean;
}

export interface PublishOutcome {
  manifest: RunManifest;
  manifestPath: string;
  carPath: string;
  uploaded: boolean;
}

const CAR_NAME = "run.car";
const MANIFEST_NAME = "manifest.json";
const NOT_PACKED = new Set([CAR_NAME, MANIFEST_NAME, "verification.json", "run-summary.json"]);

/**
 * Pack, (optionally) publish, and write the manifest for a run directory.
 * The CAR and manifest are written into the parent of `runDir`'s packed content
 * (the run directory itself) but excluded from the DAG.
 */
export async function publishRun(opts: PublishOptions): Promise<PublishOutcome> {
  const log = logger.child({ stage: "publish", runId: opts.runId });
  const carPath = path.join(opts.runDir, CAR_NAME);
  const pack = await packDirectory(opts.runDir, carPath, (rel) => NOT_PACKED.has(rel));
  log.info({ root: pack.root.cid.toString(), files: pack.entries.length, blocks: pack.blockCount, carBytes: pack.carSize }, "run packed");

  let ipns: RunManifest["ipns"] = null;
  let uploaded = false;
  let carCid: string | null = null;
  if (opts.live) {
    if (!hasFilebaseCredentials()) throw new Error("live publish requested but Filebase credentials are missing (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / S3_BUCKET)");
    const up = await uploadCar(carPath, `runs/${opts.runId}/${CAR_NAME}`);
    if (up.cid !== pack.root.cid.toString()) {
      throw new Error(`Filebase root CID ${up.cid} differs from locally computed ${pack.root.cid.toString()} — refusing to publish an unverifiable manifest`);
    }
    carCid = up.cid;
    uploaded = true;
    const name = await upsertIpns(FILEBASE.ipnsLabel, up.cid);
    ipns = { name: name.name, label: name.label, resolvedCid: up.cid, publishedAt: new Date().toISOString() };
    log.info({ cid: up.cid, ipns: name.name }, "published to Filebase and re-pointed IPNS");
  }

  const artifacts: ManifestArtifact[] = pack.entries.map((e) => {
    const table = /^query-tables\/(\w+)\.parquet$/.exec(e.name)?.[1];
    return toManifestArtifact(e, pack.carSha256, table ? (opts.rowCounts[table] ?? null) : null);
  });
  const manifest = RunManifest.parse({
    schemaVersion: "1.0",
    county: COUNTY.key,
    countyFips: COUNTY.fips,
    runId: opts.runId,
    publishedAt: new Date().toISOString(),
    root: toManifestArtifact(pack.root, pack.carSha256),
    car: { fileName: CAR_NAME, size: pack.carSize, digest: `sha256:${pack.carSha256}`, cid: carCid },
    artifacts,
    ipns,
    previousRootCid: opts.previousRootCid,
    gateways: VERIFY_GATEWAYS,
  } satisfies RunManifest);
  const manifestPath = path.join(opts.runDir, MANIFEST_NAME);
  await writeJson(manifestPath, manifest);
  return { manifest, manifestPath, carPath, uploaded };
}
