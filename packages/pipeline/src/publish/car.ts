/**
 * Content-address a run directory: build a UnixFS DAG (CIDv1, sha2-256, raw
 * leaves, 256 KiB chunks — the same defaults kubo / Filebase produce) for every
 * file, wrap it in nested UnixFS directories, and write a CAR whose single root
 * is the run directory.
 *
 * Because the CAR is what gets uploaded (Filebase imports CARs verbatim), the
 * CIDs computed here ARE the published CIDs — there is no second encoding step
 * whose output could differ. Every file's CID is also recorded so each artifact
 * is independently retrievable by its own CID.
 *
 * Memory: blocks are held in memory until the CAR is written, which is fine for
 * run directories in the hundreds of MB; a streaming variant would be needed
 * beyond that.
 *
 * @module publish/car
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as UnixFS from "@ipld/unixfs";
import { CarWriter } from "@ipld/car";
import { CID } from "multiformats/cid";
import type { ManifestArtifact } from "@osceola/shared";

/** One content-addressed entry (file or directory) inside the run. */
export interface DagEntry {
  /** Path relative to the run root, `""` for the root itself. */
  name: string;
  cid: CID;
  codec: "file" | "directory";
  /** Raw byte length for files; cumulative DAG byte length for directories. */
  size: number;
  /** sha256 hex of the raw bytes (files only). */
  sha256: string | null;
}

export interface PackResult {
  root: DagEntry;
  entries: DagEntry[];
  carPath: string;
  carSize: number;
  carSha256: string;
  blockCount: number;
}

const MEDIA_TYPES: Record<string, string> = {
  ".parquet": "application/vnd.apache.parquet",
  ".json": "application/json",
  ".csv": "text/csv",
  ".car": "application/vnd.ipld.car",
  ".md": "text/markdown",
};

export function mediaTypeFor(name: string): string | null {
  return MEDIA_TYPES[path.extname(name).toLowerCase()] ?? null;
}

/** Deterministic, sorted recursive listing (files only) relative to `root`. */
export async function listFiles(root: string, rel = ""): Promise<string[]> {
  const dir = path.join(root, rel);
  const names = (await readdir(dir)).sort();
  const out: string[] = [];
  for (const n of names) {
    const r = rel ? `${rel}/${n}` : n;
    const s = await stat(path.join(root, r));
    if (s.isDirectory()) out.push(...(await listFiles(root, r)));
    else if (s.isFile()) out.push(r);
  }
  return out;
}

/**
 * Pack `runDir` into `carPath`. Files matching `exclude` (e.g. the CAR itself
 * or a previous manifest) are skipped.
 */
export async function packDirectory(
  runDir: string,
  carPath: string,
  exclude: (relPath: string) => boolean = () => false,
): Promise<PackResult> {
  const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  const { readable, writable } = new TransformStream<UnixFS.Block, UnixFS.Block>({}, UnixFS.withCapacity(1 << 26));
  const collector = (async () => {
    const reader = readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      blocks.set(value.cid.toString(), { cid: value.cid as CID, bytes: value.bytes });
    }
  })();
  const writer = UnixFS.createWriter({ writable });

  const files = (await listFiles(runDir)).filter((f) => !exclude(f));
  const entries: DagEntry[] = [];
  const fileLinks = new Map<string, UnixFS.FileLink>();

  for (const rel of files) {
    const abs = path.join(runDir, rel);
    const fw = UnixFS.createFileWriter(writer);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(abs)) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      size += bytes.length;
      await fw.write(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    }
    const link = await fw.close();
    fileLinks.set(rel, link);
    entries.push({ name: rel, cid: link.cid as CID, codec: "file", size, sha256: hash.digest("hex") });
  }

  // Build directories bottom-up: deepest paths first so children exist before parents.
  const dirSet = new Set<string>([""]);
  for (const f of files) {
    let d = path.posix.dirname(f);
    while (d && d !== ".") {
      dirSet.add(d);
      d = path.posix.dirname(d);
    }
  }
  const dirs = [...dirSet].sort((a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a));
  const dirLinks = new Map<string, UnixFS.DirectoryLink>();
  const childrenOf = (dir: string) => {
    const prefix = dir ? `${dir}/` : "";
    const direct = new Map<string, UnixFS.FileLink | UnixFS.DirectoryLink>();
    for (const [rel, link] of fileLinks) if (path.posix.dirname(rel) === (dir || ".")) direct.set(path.posix.basename(rel), link);
    for (const [rel, link] of dirLinks) if (rel && path.posix.dirname(rel) === (dir || ".")) direct.set(path.posix.basename(rel), link);
    void prefix;
    return direct;
  };
  for (const d of dirs) {
    const dw = UnixFS.createDirectoryWriter(writer);
    for (const [name, link] of [...childrenOf(d).entries()].sort(([a], [b]) => a.localeCompare(b))) dw.set(name, link);
    const link = await dw.close();
    dirLinks.set(d, link);
    if (d !== "") entries.push({ name: d, cid: link.cid as CID, codec: "directory", size: Number(link.dagByteLength), sha256: null });
  }
  await writer.close();
  await collector;

  const rootLink = dirLinks.get("")!;
  const rootCid = rootLink.cid as CID;

  // Write the CAR with the real root (known only now).
  const { writer: car, out } = CarWriter.create([rootCid]);
  const carHash = createHash("sha256");
  let carSize = 0;
  const sink = createWriteStream(carPath);
  const pump = pipeline(
    Readable.from(
      (async function* () {
        for await (const chunk of out) {
          carHash.update(chunk);
          carSize += chunk.length;
          yield chunk;
        }
      })(),
    ),
    sink,
  );
  for (const { cid, bytes } of blocks.values()) await car.put({ cid, bytes });
  await car.close();
  await pump;

  return {
    root: { name: "", cid: rootCid, codec: "directory", size: Number(rootLink.dagByteLength), sha256: null },
    entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
    carPath,
    carSize,
    carSha256: carHash.digest("hex"),
    blockCount: blocks.size,
  };
}

/** Manifest artifact for one DAG entry (row counts are filled in by the caller). */
export function toManifestArtifact(e: DagEntry, carSha256: string, rowCount: number | null = null): ManifestArtifact {
  return {
    name: e.name,
    cid: e.cid.toString(),
    size: e.size,
    codec: e.codec,
    digest: `sha256:${e.sha256 ?? carSha256}`,
    mediaType: e.codec === "file" ? mediaTypeFor(e.name) : null,
    rowCount,
    origins: [],
  };
}
