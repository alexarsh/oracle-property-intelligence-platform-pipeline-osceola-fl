/**
 * Small filesystem / hashing helpers shared by the stages.
 * @module util/fs
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Streaming SHA-256 of a file, hex encoded. */
export async function sha256File(p: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(p)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Download `url` to `dest` (streaming). Skips when the file already exists and
 * `overwrite` is false. Returns bytes written and whether a download happened.
 */
export async function downloadFile(
  url: string,
  dest: string,
  opts: { overwrite?: boolean; headers?: Record<string, string> } = {},
): Promise<{ bytes: number; downloaded: boolean }> {
  await mkdir(path.dirname(dest), { recursive: true });
  if (!opts.overwrite && (await exists(dest))) {
    const { size } = await stat(dest);
    return { bytes: size, downloaded: false };
  }
  const res = await fetch(url, {
    headers: { "User-Agent": "oracle-osceola-pipeline/0.1", ...opts.headers },
    redirect: "follow",
  });
  if (!res.ok || !res.body)
    throw new Error(`download failed ${res.status} ${res.statusText}: ${url}`);
  const tmp = `${dest}.part`;
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(tmp));
  await rename(tmp, dest);
  return { bytes, downloaded: true };
}

export async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, "utf8")) as T;
}

export async function writeJson(p: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
