/**
 * `GET /api/verify?cid=&size=&digest=&gateway=`
 *
 * Live independent-retrieval proof: stream `<gateway>/ipfs/<cid>` server-side,
 * hash the bytes (SHA-256) and compare with the manifest size/digest. Only the
 * whitelisted gateways are allowed (SSRF guard), and the vendor gateway is
 * labelled as non-independent in the response.
 *
 * @module api/verify
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { jsonError } from "../_lib";
import { gatewayUrl, isCidV1, resolveGateway } from "@/lib/gateways";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export interface VerifyResponse {
  gateway: string;
  independent: boolean;
  url: string;
  status: number | null;
  bytes: number;
  digest: string;
  expectedBytes: number;
  expectedDigest: string;
  matched: boolean;
  ms: number;
  error: string | null;
}

export async function GET(req: Request): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const cid = searchParams.get("cid") ?? "";
  const size = Number(searchParams.get("size"));
  const digest = searchParams.get("digest") ?? "";
  const gateway = resolveGateway(searchParams.get("gateway") ?? "ipfs.io");
  const subPath = searchParams.get("path");
  if (!isCidV1(cid)) return jsonError("cid must be a CIDv1 base32 string");
  if (!Number.isInteger(size) || size < 0) return jsonError("size must be a non-negative integer");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return jsonError("digest must be sha256:<hex>");
  if (!gateway) return jsonError("gateway must be one of the whitelisted gateways");
  if (subPath && !/^[A-Za-z0-9._/-]{1,200}$/.test(subPath))
    return jsonError("path contains unsupported characters");

  const url = gatewayUrl(gateway, cid, subPath);
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 280_000);
  const base = {
    gateway: gateway.key,
    independent: gateway.independent,
    url,
    expectedBytes: size,
    expectedDigest: digest,
  };
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "osceola-explorer-verify/0.1" },
      cache: "no-store",
    });
    if (!res.ok || !res.body) {
      const body: VerifyResponse = {
        ...base,
        status: res.status,
        bytes: 0,
        digest: "",
        matched: false,
        ms: Date.now() - t0,
        error: `HTTP ${res.status}`,
      };
      return NextResponse.json(body, { status: 200 });
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      bytes += value.length;
    }
    const got = `sha256:${hash.digest("hex")}`;
    const body: VerifyResponse = {
      ...base,
      status: res.status,
      bytes,
      digest: got,
      matched: bytes === size && got === digest,
      ms: Date.now() - t0,
      error: null,
    };
    return NextResponse.json(body);
  } catch (err) {
    const body: VerifyResponse = {
      ...base,
      status: null,
      bytes: 0,
      digest: "",
      matched: false,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
    return NextResponse.json(body, { status: 200 });
  } finally {
    clearTimeout(timer);
  }
}
