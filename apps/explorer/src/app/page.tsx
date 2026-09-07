import Link from "next/link";
import { OSCEOLA } from "@osceola/shared";
import type { RunRecord } from "@osceola/shared";
import { Badge, ExtLink, KV, Notice, PageHeader, Section, Stat } from "@/components/ui";
import { loadArtifacts } from "@/lib/artifacts";
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
  const rec = latest.record;
  const previous = snap.runs[1] ?? null;
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
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Fetched at</th>
                <th className="text-right">Seen</th>
                <th className="text-right">New</th>
                <th className="text-right">Changed</th>
                <th className="text-right">Quarantined</th>
                <th>Window / requests</th>
                <th>Limitations</th>
              </tr>
            </thead>
            <tbody>
              {rec.sources.map((s) => {
                const cfg = OSCEOLA.sources[s.source];
                return (
                  <tr key={s.source}>
                    <td>
                      <div className="font-medium">{cfg?.label ?? s.source}</div>
                      <div className="text-xs text-zinc-500">
                        {cfg?.custodian ?? ""} {cfg ? `· ${cfg.accessMode} · ${cfg.cadence}` : ""}
                      </div>
                      <div className="mt-0.5 flex flex-col">
                        {s.urls.slice(0, 2).map((u) => (
                          <span key={u} className="mono truncate text-zinc-500">
                            <ExtLink href={u}>{u.length > 70 ? `${u.slice(0, 70)}…` : u}</ExtLink>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                      {s.error ? <div className="mt-1 text-xs text-rose-700">{s.error}</div> : null}
                    </td>
                    <td className="whitespace-nowrap text-xs">{fmtDateTime(s.fetchedAt)}</td>
                    <td className="text-right tabular-nums">{fmtInt(s.recordsSeen)}</td>
                    <td className="text-right tabular-nums">{fmtInt(s.recordsNew)}</td>
                    <td className="text-right tabular-nums">{fmtInt(s.recordsChanged)}</td>
                    <td className="text-right tabular-nums">{fmtInt(s.recordsQuarantined)}</td>
                    <td className="text-xs">
                      {s.window
                        ? Object.entries(s.window)
                            .map(([k, v]) => `${k}=${v}`)
                            .join(" ")
                        : "—"}
                      {s.requestCount != null ? <div>{fmtInt(s.requestCount)} requests</div> : null}
                      {s.durationMs ? <div>{(s.durationMs / 1000).toFixed(0)} s</div> : null}
                    </td>
                    <td className="max-w-md text-xs">
                      <ul className="list-disc space-y-0.5 pl-4">
                        {s.limitations.map((l) => (
                          <li key={l}>{l}</li>
                        ))}
                      </ul>
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
                latest.manifest?.ipns ? (
                  <span>
                    <span className="mono">{latest.manifest.ipns.name}</span> →{" "}
                    <span className="mono">{latest.manifest.ipns.resolvedCid}</span>
                    <span className="text-xs text-zinc-500">
                      {" "}
                      (published {fmtDateTime(latest.manifest.ipns.publishedAt)})
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
                latest.manifest ? (
                  <span>
                    {latest.manifest.car.fileName} · {fmtInt(latest.manifest.car.size)} bytes ·{" "}
                    <span className="mono">{latest.manifest.car.digest}</span>
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
        description="Every run with its root CID. Prior CIDs are never rewritten: an incremental publish appends a new record with a new root CID and keeps the previous one."
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
                <th>Verified</th>
              </tr>
            </thead>
            <tbody>
              {snap.runs.map((r) => (
                <tr key={r.runId}>
                  <td className="font-mono text-xs">
                    {r.runId}
                    {r.derived ? <span className="ml-1 text-amber-600">*</span> : null}
                  </td>
                  <td>{r.record.mode}</td>
                  <td>
                    <Badge tone={statusTone(r.record.status)}>{r.record.status}</Badge>
                  </td>
                  <td className="text-xs whitespace-nowrap">{fmtDateTime(r.record.startedAt)}</td>
                  <td className="text-xs whitespace-nowrap">{fmtDateTime(r.record.finishedAt)}</td>
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
                      "—"
                    )}
                  </td>
                  <td className="mono" title={r.record.previousRootCid ?? ""}>
                    {shortCid(r.record.previousRootCid, 12)}
                  </td>
                  <td>
                    {r.record.verification ? (
                      <Badge tone={r.record.verification.allMatched ? "ok" : "bad"}>
                        {r.record.verification.allMatched ? "matched" : "mismatch"}
                      </Badge>
                    ) : (
                      <Badge tone="muted">—</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {snap.runs.some((r) => r.derived) ? (
          <p className="mt-2 text-xs text-zinc-500">
            * record derived from the run directory's manifest.json because
            artifacts/run-history.json has no entry yet.
          </p>
        ) : null}
      </Section>
    </>
  );
}
