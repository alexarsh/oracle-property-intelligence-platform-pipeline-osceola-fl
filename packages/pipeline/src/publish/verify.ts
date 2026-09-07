/**
 * Independent-retrieval proof.
 *
 * For every `file` artifact in a manifest, fetch `<gateway>/ipfs/<cid>` from
 * each configured public gateway that this project does not operate, stream the
 * bytes, and compare length and SHA-256 with the manifest. The directory root is
 * proven by path-resolving one file through it (`/ipfs/<root>/<name>`), which
 * exercises the directory DAG on the gateway side.
 *
 * Results are written as `verification.json` next to the manifest and summarized
 * in run history. A failure is reported, never hidden.
 *
 * @module publish/verify
 */
import { createHash } from "node:crypto";
import type { RunManifest } from "@osceola/shared";
import { logger } from "../logger.js";

export interface FetchCheck {
  gateway: string;
  url: string;
  ok: boolean;
  status: number | null;
  bytes: number | null;
  sha256: string | null;
  matched: boolean;
  ms: number;
  error: string | null;
}

export interface ArtifactVerification {
  name: string;
  cid: string;
  expectedSize: number;
  expectedDigest: string;
  checks: FetchCheck[];
}

export interface VerificationReport {
  runId: string;
  verifiedAt: string;
  gateways: string[];
  artifacts: ArtifactVerification[];
  rootPathCheck: FetchCheck[];
  allMatched: boolean;
}

async function fetchAndHash(
  url: string,
  expectedSize: number,
  expectedDigest: string,
  timeoutMs: number,
): Promise<Omit<FetchCheck, "gateway">> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "oracle-osceola-verify/0.1" },
      redirect: "follow",
    });
    if (!res.ok || !res.body) {
      return {
        url,
        ok: false,
        status: res.status,
        bytes: null,
        sha256: null,
        matched: false,
        ms: Date.now() - t0,
        error: `HTTP ${res.status}`,
      };
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      bytes += value.length;
    }
    const digest = `sha256:${hash.digest("hex")}`;
    return {
      url,
      ok: true,
      status: res.status,
      bytes,
      sha256: digest,
      matched: bytes === expectedSize && digest === expectedDigest,
      ms: Date.now() - t0,
      error: null,
    };
  } catch (err) {
    return {
      url,
      ok: false,
      status: null,
      bytes: null,
      sha256: null,
      matched: false,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface VerifyOptions {
  gateways: string[];
  /** Per-request timeout; large Parquet files through public gateways can be slow. */
  timeoutMs?: number;
  /** Retries per gateway (gateways rate-limit and time out on first fetch of a cold CID). */
  attempts?: number;
  /** Restrict to these artifact names (default: all files). */
  only?: string[];
}

export async function verifyManifest(
  manifest: RunManifest,
  opts: VerifyOptions,
): Promise<VerificationReport> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const attempts = opts.attempts ?? 3;
  const log = logger.child({ stage: "verify", runId: manifest.runId });
  const files = manifest.artifacts.filter(
    (a) => a.codec === "file" && (!opts.only || opts.only.includes(a.name)),
  );
  const artifacts: ArtifactVerification[] = [];

  for (const a of files) {
    const checks: FetchCheck[] = [];
    for (const gateway of opts.gateways) {
      const url = `${gateway.replace(/\/$/, "")}/ipfs/${a.cid}`;
      let check: Omit<FetchCheck, "gateway"> | null = null;
      for (let i = 1; i <= attempts; i++) {
        check = await fetchAndHash(url, a.size, a.digest, timeoutMs);
        if (check.matched) break;
        log.warn(
          { url, attempt: i, error: check.error ?? `mismatch (${check.bytes} bytes)` },
          "gateway fetch not matched yet",
        );
        await new Promise((r) => setTimeout(r, 5_000 * i));
      }
      checks.push({ gateway, ...check! });
      log.info(
        { name: a.name, gateway, matched: check!.matched, ms: check!.ms, bytes: check!.bytes },
        "verified",
      );
    }
    artifacts.push({
      name: a.name,
      cid: a.cid,
      expectedSize: a.size,
      expectedDigest: a.digest,
      checks,
    });
  }

  // Root proof: resolve the smallest file *through* the directory root.
  const probe = [...files].sort((x, y) => x.size - y.size)[0];
  const rootPathCheck: FetchCheck[] = [];
  if (probe) {
    for (const gateway of opts.gateways) {
      const url = `${gateway.replace(/\/$/, "")}/ipfs/${manifest.root.cid}/${probe.name}`;
      let check: Omit<FetchCheck, "gateway"> | null = null;
      for (let i = 1; i <= attempts && !check?.matched; i++)
        check = await fetchAndHash(url, probe.size, probe.digest, timeoutMs);
      rootPathCheck.push({ gateway, ...check! });
    }
  }

  const allMatched =
    artifacts.every((a) => a.checks.every((c) => c.matched)) &&
    rootPathCheck.every((c) => c.matched);
  return {
    runId: manifest.runId,
    verifiedAt: new Date().toISOString(),
    gateways: opts.gateways,
    artifacts,
    rootPathCheck,
    allMatched,
  };
}
