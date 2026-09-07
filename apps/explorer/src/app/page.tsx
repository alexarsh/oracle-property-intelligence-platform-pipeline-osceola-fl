import Link from "next/link";
import { OSCEOLA } from "@osceola/shared";
import type { RunRecord } from "@osceola/shared";
import { Badge, ExtLink, KV, Notice, PageHeader, Section, Stat } from "@/components/ui";
import { chainStatus, loadArtifacts } from "@/lib/artifacts";
import { fmtDateTime, fmtDelta, fmtInt, shortCid } from "@/lib/format";
import { GATEWAYS, gatewayUrl } from "@/lib/gateways";

export const dynamic = "force-dynamic";

function statusTone(
  s: RunRecord["status"] | RunRecord["sources"][number]["status"],
): "ok" | "warn" | "bad" | "muted" {
  if (s === "succeeded" || s === "ok") return "ok";
  if (s === "partial" || s === "running") return "warn";
  if (s === "failed" || s === "blocked") return "bad";
  return "muted";
}

export default async function RunSummaryPage() {
  const snap = await loadArtifacts();
  const latest = snap.latest;
  if (!latest) {
    return (
      <>
        <PageHeader
          title="Pipeline run summary"
          transcript="First, I am opening the pipeline run summary."
        />
        <Notice tone="bad">No pipeline run found. {snap.warnings.join(" ")}</Notice>
      </>
    );
  }
  // Summarize the newest *published* run; a run that is still in progress is announced but
  // does not replace the published figures (it has no counts or CIDs yet).
  const inProgress = latest.record.status === "running" ? latest : null;
  const shown = inProgress ? (snap.latestPublished ?? latest) : latest;
  const rec = shown.record;
  const shownIndex = snap.runs.findIndex((r) => r.runId === shown.runId);
  const previous =
    snap.runs.slice(shownIndex + 1).find((r) => r.record.status === "succeeded") ?? null;
  const tables = Object.entries(rec.tableCounts);
  const publicGateways = GATEWAYS.filter((g) => g.independent);

  return (
    <>
      <PageHeader
        title="Pipeline run summary"
        transcript="First, I am opening the pipeline run summary."
      >
        <div className="text-sm text-zinc-500">
          {OSCEOLA.name} County, {OSCEOLA.stateCode} · FIPS {OSCEOLA.fips} · {snap.runs.length} run
          {snap.runs.length === 1 ? "" : "s"} on record
        </div>
      </PageHeader>

      {snap.warnings.map((w) => (
        <Notice key={w}>{w}</Notice>
      ))}
      {inProgress && inProgress.runId !== shown.runId ? (
        <Notice>
          Run <span className="font-mono">{inProgress.runId}</span> ({inProgress.record.mode}) is in
          progress since {fmtDateTime(inProgress.record.startedAt)}; the figures below are for the
          last published run <span className="font-mono">{shown.runId}</span>.
        </Notice>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Run"
          value={<span className="font-mono text-sm">{rec.runId}</span>}
          sub={<Badge tone={statusTone(rec.status)}>{rec.status}</Badge>}
        />
        <Stat
          label="Mode"
          value={rec.mode}
          sub={
            rec.pipelineCommit ? (
              <span className="font-mono">commit {rec.pipelineCommit.slice(0, 10)}</span>
            ) : (
              "pipeline commit not recorded"
            )
          }
        />
        <Stat
          label="Started"
          value={<span className="text-base">{fmtDateTime(rec.startedAt)}</span>}
          sub={`finished ${fmtDateTime(rec.finishedAt)}`}
        />
        <Stat
          label="Verification"
          value={
            rec.verification ? (
              <Badge tone={rec.verification.allMatched ? "ok" : "bad"}>
                {rec.verification.allMatched ? "all matched" : "mismatch"}
              </Badge>
            ) : (
              <Badge tone="warn">not yet run</Badge>
            )
          }
          sub={
            rec.verification
              ? `${rec.verification.artifactsChecked} artifacts · ${rec.verification.gateways.join(", ")} · ${fmtDateTime(rec.verification.verifiedAt)}`
              : "verification.json missing for this run"
          }
        />
      </div>

      <Section
        title="Uploaded records by source"
        description="Every source the run touched, with what it saw, what was new or changed, what was quarantined, and the custodian's documented limitations (verbatim from the run record)."
      >
        <div className="table-wrap">
          <table className="text-xs">
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Fetched at</th>
                <th className="text-right">Seen</th>
                <th className="text-right">New</th>
                <th className="text-right">Changed</th>
                <th className="text-right">Quarantined</th>
                <th>Window</th>
                <th>Limitations</th>
              </tr>
            </thead>
            <tbody>
              {rec.sources.map((s) => {
                const cfg = OSCEOLA.sources[s.source];
                const url = s.urls[0] ?? cfg?.url ?? null;
                return (
                  <tr key={s.source} className="align-middle">
                    <td className="py-1">
                      <div className="font-medium">{cfg?.label ?? s.source}</div>
                      <div className="text-zinc-500">
                        {cfg ? `${cfg.accessMode} · ${cfg.cadence}` : s.source}
                        {url ? (
                          <>
                            {" · "}
                            <ExtLink href={url}>{new URL(url).hostname}</ExtLink>
                          </>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-1">
                      <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                      {s.error ? <div className="mt-0.5 text-rose-700">{s.error}</div> : null}
                    </td>
                    <td className="py-1 whitespace-nowrap">{fmtDateTime(s.fetchedAt)}</td>
                    <td className="py-1 text-right tabular-nums">{fmtInt(s.recordsSeen)}</td>
                    <td className="py-1 text-right tabular-nums">{fmtInt(s.recordsNew)}</td>
                    <td className="py-1 text-right tabular-nums">{fmtInt(s.recordsChanged)}</td>
                    <td className="py-1 text-right tabular-nums">{fmtInt(s.recordsQuarantined)}</td>
                    <td className="py-1 whitespace-nowrap">
                      {s.window
                        ? Object.entries(s.window)
                            .map(([k, v]) => `${k}=${v}`)
                            .join(" ")
                        : "—"}
                      {(s.requestCount ?? 0) > 0 || s.durationMs > 0 ? (
                        <div className="text-zinc-500">
                          {(s.requestCount ?? 0) > 0 ? `${fmtInt(s.requestCount)} req` : ""}
                          {(s.requestCount ?? 0) > 0 && s.durationMs > 0 ? " · " : ""}
                          {s.durationMs ? `${(s.durationMs / 1000).toFixed(0)} s` : ""}
                        </div>
                      ) : null}
                    </td>
                    <td className="max-w-md py-1">
                      {s.limitations.length ? (
                        <details>
                          <summary className="cursor-pointer text-zinc-600 dark:text-zinc-300">
                            {s.limitations.length} documented limitation
                            {s.limitations.length === 1 ? "" : "s"}
                          </summary>
                          <ul className="mt-1 list-disc space-y-0.5 pl-4">
                            {s.limitations.map((l) => (
                              <li key={l}>{l}</li>
                            ))}
                          </ul>
                        </details>
                      ) : (
                        <span className="text-zinc-500">none recorded</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Published query tables"
        description={`Row counts after this run and deltas versus the previous successful run${previous ? ` (${previous.runId})` : ""}.`}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {tables.map(([name, count]) => (
            <Stat
              key={name}
              label={`${name}.parquet`}
              value={fmtInt(count)}
              sub={
                previous ? (
                  <span>
                    Δ{" "}
                    {fmtDelta(
                      rec.tableDeltas[name] ?? count - (previous.record.tableCounts[name] ?? 0),
                    )}{" "}
                    vs {previous.runId}
                  </span>
                ) : (
                  <span>first published run — no previous snapshot to diff</span>
                )
              }
            />
          ))}
        </div>
      </Section>

      <Section
        title="Content-addressed publication"
        description="CIDs are the durable identity. Gateway URLs below are derived from the CIDs; IPNS is a pointer whose resolved CID is recorded per run."
      >
        <div className="card">
          <KV
            rows={[
              [
                "Root CID (this run)",
                rec.rootCid ? <span className="mono">{rec.rootCid}</span> : "—",
              ],
              [
                "Previous root CID",
                rec.previousRootCid ? (
                  <span className="mono">{rec.previousRootCid}</span>
                ) : (
                  <span className="text-zinc-500">none (first run)</span>
                ),
              ],
              [
                "Manifest CID",
                rec.manifestCid ? (
                  <span className="mono">{rec.manifestCid}</span>
                ) : (
                  <span className="text-zinc-500">
                    manifest is inside the root directory (manifest.json)
                  </span>
                ),
              ],
              [
                "IPNS",
                shown.manifest?.ipns ? (
                  <span>
                    <span className="mono">{shown.manifest.ipns.name}</span> →{" "}
                    <span className="mono">{shown.manifest.ipns.resolvedCid}</span>
                    <span className="text-xs text-zinc-500">
                      {" "}
                      (published {fmtDateTime(shown.manifest.ipns.publishedAt)})
                    </span>
                  </span>
                ) : (
                  <span className="text-zinc-500">{rec.ipnsName ?? "not used in this run"}</span>
                ),
              ],
              [
                "Derived gateway URLs",
                rec.rootCid ? (
                  <span className="flex flex-col">
                    {publicGateways.map((g) => (
                      <ExtLink key={g.key} href={gatewayUrl(g, rec.rootCid!)}>
                        {gatewayUrl(g, rec.rootCid!)}
                      </ExtLink>
                    ))}
                  </span>
                ) : (
                  "—"
                ),
              ],
              [
                "CAR",
                shown.manifest ? (
                  <span>
                    {shown.manifest.car.fileName} · {fmtInt(shown.manifest.car.size)} bytes ·{" "}
                    <span className="mono">{shown.manifest.car.digest}</span>
                  </span>
                ) : (
                  "—"
                ),
              ],
            ]}
          />
          <div className="mt-3 text-sm">
            <Link className="btn" href="/manifest">
              Open artifact manifest →
            </Link>
          </div>
        </div>
      </Section>

      {rec.notes.length > 0 ? (
        <Section title="Run notes">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {rec.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section
        title="Run history"
        description="Every run in artifacts/run-history.json, newest first. Prior CIDs are never rewritten: a new publish appends a record whose previousRootCid is the root CID of the run before it — the immutability chain is checked row by row."
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Started</th>
                <th>Finished</th>
                <th className="text-right">properties</th>
                <th className="text-right">permits</th>
                <th className="text-right">contractors</th>
                <th>Root CID</th>
                <th>Previous root</th>
                <th>Chain</th>
                <th>IPNS → resolved CID</th>
                <th>Verified</th>
              </tr>
            </thead>
            <tbody>
              {snap.runs.map((r, i) => {
                const chain = chainStatus(snap.runs, i);
                const ipns = r.manifest?.ipns ?? null;
                return (
                  <tr
                    key={r.runId}
                    id={`run-${r.runId}`}
                    className={chain === "linked" ? "bg-emerald-50/50 dark:bg-emerald-950/20" : ""}
                  >
                    <td className="font-mono text-xs">{r.runId}</td>
                    <td>{r.record.mode}</td>
                    <td>
                      <Badge tone={statusTone(r.record.status)}>{r.record.status}</Badge>
                    </td>
                    <td className="text-xs whitespace-nowrap">{fmtDateTime(r.record.startedAt)}</td>
                    <td className="text-xs whitespace-nowrap">
                      {fmtDateTime(r.record.finishedAt)}
                    </td>
                    <td className="text-right tabular-nums">
                      {fmtInt(r.record.tableCounts.properties)}
                    </td>
                    <td className="text-right tabular-nums">
                      {fmtInt(r.record.tableCounts.permits)}
                    </td>
                    <td className="text-right tabular-nums">
                      {fmtInt(r.record.tableCounts.contractors)}
                    </td>
                    <td className="mono" title={r.record.rootCid ?? ""}>
                      {r.record.rootCid ? (
                        <ExtLink href={gatewayUrl(publicGateways[0]!, r.record.rootCid)}>
                          {shortCid(r.record.rootCid, 12)}
                        </ExtLink>
                      ) : (
                        <span className="text-zinc-500">not published yet</span>
                      )}
                    </td>
                    <td className="mono" title={r.record.previousRootCid ?? ""}>
                      {r.record.previousRootCid ? (
                        shortCid(r.record.previousRootCid, 12)
                      ) : (
                        <span className="text-zinc-500">none</span>
                      )}
                    </td>
                    <td>
                      {chain === "linked" ? (
                        <Badge tone="ok">links to prior root</Badge>
                      ) : chain === "first" ? (
                        <Badge tone="muted">first snapshot</Badge>
                      ) : chain === "pending" ? (
                        <Badge tone="warn">pending</Badge>
                      ) : (
                        <Badge tone="bad">does not match prior root</Badge>
                      )}
                    </td>
                    <td
                      className="mono max-w-[16rem]"
                      title={
                        ipns ? `${ipns.name} → ${ipns.resolvedCid}` : (r.record.ipnsName ?? "")
                      }
                    >
                      {ipns ? (
                        <span>
                          {shortCid(ipns.name, 8)} → {shortCid(ipns.resolvedCid, 12)}
                        </span>
                      ) : r.record.ipnsName ? (
                        <span>{shortCid(r.record.ipnsName, 8)} → (manifest not committed)</span>
                      ) : (
                        <span className="text-zinc-500">—</span>
                      )}
                    </td>
                    <td>
                      {r.record.verification ? (
                        <Badge tone={r.record.verification.allMatched ? "ok" : "bad"}>
                          {r.record.verification.allMatched
                            ? `matched (${r.record.verification.artifactsChecked})`
                            : "mismatch"}
                        </Badge>
                      ) : (
                        <Badge tone="muted">not verified</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
