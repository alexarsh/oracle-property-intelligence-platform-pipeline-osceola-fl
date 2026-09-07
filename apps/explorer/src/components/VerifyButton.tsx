"use client";
import { useState } from "react";
import type { VerifyResponse } from "@/app/api/verify/route";
import { GATEWAYS } from "@/lib/gateways";
import { fmtBytes } from "@/lib/format";

interface Props {
  cid: string;
  size: number;
  digest: string;
  /** For directory roots: a file path resolved through the root. */
  path?: string;
  compact?: boolean;
}

type State =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: VerifyResponse }
  | { status: "error"; message: string };

/** One button per gateway; streams the bytes server-side and reports size/digest match live. */
export function VerifyButtons({ cid, size, digest, path, compact }: Props) {
  const [states, setStates] = useState<Record<string, State>>({});
  const run = async (gateway: string) => {
    setStates((s) => ({ ...s, [gateway]: { status: "running" } }));
    try {
      const params = new URLSearchParams({ cid, size: String(size), digest, gateway });
      if (path) params.set("path", path);
      const res = await fetch(`/api/verify?${params.toString()}`, { cache: "no-store" });
      const body = (await res.json()) as
        VerifyResponse | { error: string; details?: string | null };
      if (!("expectedDigest" in body))
        setStates((s) => ({ ...s, [gateway]: { status: "error", message: body.error } }));
      else setStates((s) => ({ ...s, [gateway]: { status: "done", result: body } }));
    } catch (err) {
      setStates((s) => ({
        ...s,
        [gateway]: { status: "error", message: err instanceof Error ? err.message : String(err) },
      }));
    }
  };
  return (
    <div
      className={`flex flex-col gap-1 ${compact ? "" : "sm:flex-row sm:flex-wrap sm:items-start sm:gap-3"}`}
    >
      {GATEWAYS.map((g) => {
        const st = states[g.key] ?? { status: "idle" };
        return (
          <div key={g.key} className="flex flex-col gap-0.5">
            <button
              type="button"
              className="btn text-xs"
              disabled={st.status === "running"}
              onClick={() => void run(g.key)}
              title={
                g.independent
                  ? "Public gateway this project does not operate"
                  : "Pinning vendor gateway (not independent)"
              }
            >
              {st.status === "running" ? "Fetching…" : `Verify via ${g.label}`}
            </button>
            {st.status === "done" ? (
              <span
                className={`text-xs ${st.result.matched ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}`}
              >
                {st.result.matched ? "MATCH" : "MISMATCH"} · {fmtBytes(st.result.bytes)} ·{" "}
                {(st.result.ms / 1000).toFixed(1)} s{st.result.error ? ` · ${st.result.error}` : ""}
                {st.result.matched
                  ? ""
                  : st.result.digest
                    ? ` · got ${st.result.digest.slice(0, 19)}…`
                    : ""}
              </span>
            ) : null}
            {st.status === "error" ? (
              <span className="text-xs text-rose-700 dark:text-rose-400">{st.message}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
