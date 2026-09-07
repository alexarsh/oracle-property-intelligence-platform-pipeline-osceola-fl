/**
 * Filebase publication (S3-compatible IPFS pinning + IPNS names API).
 *
 * The run CAR is uploaded with the `import: car` object metadata, which makes
 * Filebase import the DAG as-is and pin the CAR's root — so the CID Filebase
 * reports back is byte-for-byte the CID we computed locally (`publish/car`).
 * That equality is asserted, never assumed.
 *
 * IPNS is a pointer, not the artifact: the label `oracle-osceola-runs` is
 * re-pointed at every new run root, and the resolved CID is recorded alongside
 * it in the manifest and run history so previous snapshots stay addressable.
 *
 * Credentials come from the environment only (see `config.ts`) and are never
 * logged. Nothing here runs unless `hasFilebaseCredentials()` is true.
 *
 * @module publish/filebase
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { FILEBASE } from "../config.js";
import { logger } from "../logger.js";

function client(): S3Client {
  return new S3Client({
    endpoint: FILEBASE.s3Endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: FILEBASE.accessKeyId, secretAccessKey: FILEBASE.secretAccessKey },
  });
}

function bearer(): string {
  return Buffer.from(`${FILEBASE.accessKeyId}:${FILEBASE.secretAccessKey}`, "utf8").toString(
    "base64",
  );
}

/** Poll HeadObject until Filebase has finished the (asynchronous) CAR import and exposes the CID. */
async function waitForCid(s3: S3Client, key: string, timeoutMs = 10 * 60_000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const head = await s3.send(new HeadObjectCommand({ Bucket: FILEBASE.bucket, Key: key }));
    const cid = head.Metadata?.cid ?? head.Metadata?.["cid"];
    if (cid) return cid;
    if (Date.now() - started > timeoutMs)
      throw new Error(`Filebase did not report a CID for ${key} within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

export interface UploadResult {
  key: string;
  cid: string;
  bytes: number;
}

/** Upload a CAR and import it; returns the root CID Filebase pinned. */
export async function uploadCar(carPath: string, key: string): Promise<UploadResult> {
  const s3 = client();
  const { size } = await stat(carPath);
  logger.info({ key, bytes: size }, "uploading CAR to Filebase");
  await s3.send(
    new PutObjectCommand({
      Bucket: FILEBASE.bucket,
      Key: key,
      Body: createReadStream(carPath),
      ContentLength: size,
      ContentType: "application/vnd.ipld.car",
      Metadata: { import: "car" },
    }),
  );
  const cid = await waitForCid(s3, key);
  return { key, cid, bytes: size };
}

/** Upload a single small file (e.g. the manifest) and return its CID. */
export async function uploadFile(
  filePath: string,
  key: string,
  contentType: string,
): Promise<UploadResult> {
  const s3 = client();
  const { size } = await stat(filePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: FILEBASE.bucket,
      Key: key,
      Body: createReadStream(filePath),
      ContentLength: size,
      ContentType: contentType,
    }),
  );
  const cid = await waitForCid(s3, key, 60_000);
  return { key, cid, bytes: size };
}

export interface IpnsResult {
  label: string;
  /** The resolvable IPNS name (`k51…`). */
  name: string;
  cid: string;
}

/** Create-or-update the IPNS label to point at `cid`; returns the network key. */
export async function upsertIpns(label: string, cid: string): Promise<IpnsResult> {
  const headers = { Authorization: `Bearer ${bearer()}`, "Content-Type": "application/json" };
  const existing = await fetch(`${FILEBASE.namesApi}/${encodeURIComponent(label)}`, { headers });
  let res: Response;
  if (existing.ok) {
    res = await fetch(`${FILEBASE.namesApi}/${encodeURIComponent(label)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ cid }),
    });
  } else {
    res = await fetch(FILEBASE.namesApi, {
      method: "POST",
      headers,
      body: JSON.stringify({ label, cid, enabled: true }),
    });
  }
  if (!res.ok) throw new Error(`Filebase names API ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { network_key?: string; cid?: string };
  const name =
    body.network_key ??
    (
      (await (
        await fetch(`${FILEBASE.namesApi}/${encodeURIComponent(label)}`, { headers })
      ).json()) as { network_key: string }
    ).network_key;
  return { label, name, cid };
}

/** Vendor gateway URL for a CID (convenience only; CIDs are the identity). */
export function filebaseGatewayUrl(cid: string, subPath = ""): string {
  return `${FILEBASE.gateway}/ipfs/${cid}${subPath ? `/${subPath}` : ""}`;
}
