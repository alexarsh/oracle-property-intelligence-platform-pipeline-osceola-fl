import { Badge, ExtLink, KV, Notice, PageHeader, Section } from "@/components/ui";
import { VerifyButtons } from "@/components/VerifyButton";
import { CopyBlock } from "@/components/CopyBlock";
import { loadArtifacts } from "@/lib/artifacts";
import { fmtBytes, fmtDateTime, fmtInt } from "@/lib/format";
import { GATEWAYS, gatewayUrl } from "@/lib/gateways";

export const dynamic = "force-dynamic";

export default async function ManifestPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const { run: runParam } = await searchParams;
  const snap = await loadArtifacts();
  const run = (runParam ? snap.runs.find((r) => r.runId === runParam) : snap.latest) ?? snap.latest;
  const m = run?.manifest ?? null;
  if (!run || !m) {
    return (
      <>
        <PageHeader
          title="Artifact manifest"
          transcript="Show the published artifact manifest for this run."
        />
        <Notice tone="bad">manifest.json not found. {snap.warnings.join(" ")}</Notice>
      </>
    );
  }
  const files = m.artifacts.filter((a) => a.codec === "file");
  const smallest = [...files].sort((a, b) => a.size - b.size)[0];
  const v = run.verification;

  return (
    <>
      <PageHeader
        title="Artifact manifest"
        transcript="Show the published artifact manifest for this run."
      >
        <form className="flex items-center gap-2 text-sm">
          <label htmlFor="run" className="text-zinc-500">
            Run
          </label>
          <select id="run" name="run" defaultValue={run.runId} className="input w-auto">
            {snap.runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.runId}
              </option>
            ))}
          </select>
          <button className="btn" type="submit">
            Open
          </button>
        </form>
      </PageHeader>

      <div className="card mb-6">
        <KV
          rows={[
            [
              "Run",
              <span key="r" className="font-mono">
                {m.runId}
              </span>,
            ],
            ["Sealed at", fmtDateTime(m.publishedAt)],
            ["Schema", `manifest v${m.schemaVersion} · county ${m.county} (FIPS ${m.countyFips})`],
            [
              "Root directory CID",
              <span key="root">
                <span className="mono">{m.root.cid}</span>
                <span className="text-xs text-zinc-500">
                  {" "}
                  · {fmtBytes(m.root.size)} · {m.root.codec}
                </span>
              </span>,
            ],
            [
              "Previous root CID",
              m.previousRootCid ? (
                <span key="p" className="mono">
                  {m.previousRootCid}
                </span>
              ) : (
                <span key="p" className="text-zinc-500">
                  none (first publication)
                </span>
              ),
            ],
            [
              "IPNS",
              m.ipns ? (
                <span key="i">
                  <span className="mono">{m.ipns.name}</span> (label {m.ipns.label}) → resolved CID{" "}
                  <span className="mono">{m.ipns.resolvedCid}</span> at{" "}
                  {fmtDateTime(m.ipns.publishedAt)}
                </span>
              ) : (
                <span key="i" className="text-zinc-500">
                  not used in this run — the root CID is the snapshot identity
                </span>
              ),
            ],
            ["Proof gateways", m.gateways.join(", ")],
          ]}
        />
      </div>

      <Section
        title="Artifacts"
        description="Every eligible object with CID (CIDv1 base32), logical name, size, UnixFS codec, SHA-256 digest and row count. Gateway links are derived from the CID at render time. “Verify” streams the bytes through the explorer's server, hashes them and compares with the manifest — the live independent-retrieval proof."
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Codec</th>
                <th className="text-right">Size</th>
                <th className="text-right">Rows</th>
                <th>CID</th>
                <th>Digest</th>
                <th>Gateways</th>
                <th>Verify now</th>
              </tr>
            </thead>
            <tbody>
              {m.artifacts.map((a) => (
                <tr key={a.name || "(root)"}>
                  <td className="font-medium whitespace-nowrap">
                    {a.name || "(root)"}
                    {a.mediaType ? (
                      <div className="text-xs font-normal text-zinc-500">{a.mediaType}</div>
                    ) : null}
                  </td>
                  <td>
                    <Badge tone={a.codec === "directory" ? "muted" : "ok"}>{a.codec}</Badge>
                  </td>
                  <td
                    className="text-right tabular-nums whitespace-nowrap"
                    title={`${fmtInt(a.size)} bytes`}
                  >
                    {fmtBytes(a.size)}
                  </td>
                  <td className="text-right tabular-nums">
                    {a.rowCount == null ? "—" : fmtInt(a.rowCount)}
                  </td>
                  <td className="mono max-w-[14rem]">{a.cid}</td>
                  <td className="mono max-w-[12rem]" title={a.digest}>
                    {a.digest.slice(0, 23)}…
                  </td>
                  <td className="text-xs">
                    <div className="flex flex-col gap-0.5">
                      {GATEWAYS.map((g) => (
                        <ExtLink key={g.key} href={gatewayUrl(g, a.cid)}>
                          {g.label}
                        </ExtLink>
                      ))}
                    </div>
                  </td>
                  <td>
                    {a.codec === "file" ? (
                      <VerifyButtons cid={a.cid} size={a.size} digest={a.digest} compact />
                    ) : (
                      <span className="text-xs text-zinc-500">
                        directory: proven by resolving a file through it (below)
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {smallest ? (
          <div className="card mt-3">
            <div className="text-sm font-medium">Directory-root proof</div>
            <p className="mb-2 text-xs text-zinc-500">
              Fetch{" "}
              <span className="mono">
                /ipfs/{m.root.cid}/{smallest.name}
              </span>{" "}
              and compare with the file's manifest digest: a match proves the gateway resolved the
              directory DAG, not just a single block.
            </p>
            <VerifyButtons
              cid={m.root.cid}
              size={smallest.size}
              digest={smallest.digest}
              path={smallest.name}
            />
          </div>
        ) : null}
      </Section>

      <Section
        title="CAR (Content Addressable aRchive)"
        description="The CAR carries the whole DAG rooted at the root CID — every directory node and file block — so any IPFS node can `ipfs dag import run.car` and serve the identical CID without re-encoding or re-hashing. It is committed next to the manifest as the offline copy of the snapshot."
      >
        <div className="card">
          <KV
            rows={[
              [
                "File",
                <span key="f" className="font-mono">
                  artifacts/runs/{m.runId}/{m.car.fileName}
                </span>,
              ],
              ["Size", `${fmtBytes(m.car.size)} (${fmtInt(m.car.size)} bytes)`],
              [
                "Digest",
                <span key="d" className="mono">
                  {m.car.digest}
                </span>,
              ],
              [
                "CAR CID",
                m.car.cid ? (
                  <span key="c" className="mono">
                    {m.car.cid}
                  </span>
                ) : (
                  <span key="c" className="text-zinc-500">
                    not pinned as its own object (the root CID is inside it)
                  </span>
                ),
              ],
              [
                "Import",
                <code key="i" className="text-xs">
                  ipfs dag import run.car &amp;&amp; ipfs ls {m.root.cid}
                </code>,
              ],
            ]}
          />
        </div>
      </Section>

      <Section
        title="Last verification (verification.json)"
        description="Written by the pipeline's verify stage after publication: each file artifact fetched from each proof gateway, bytes hashed and compared."
      >
        {v ? (
          <div className="card">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={v.allMatched ? "ok" : "bad"}>
                {v.allMatched ? "all artifacts matched" : "mismatch detected"}
              </Badge>
              <span className="text-zinc-500">
                {fmtDateTime(v.verifiedAt)} · gateways {v.gateways.join(", ")}
              </span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Artifact</th>
                    <th>Gateway</th>
                    <th>HTTP</th>
                    <th className="text-right">Bytes</th>
                    <th>Digest match</th>
                    <th className="text-right">Time</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {v.artifacts.flatMap((a) =>
                    a.checks.map((c) => (
                      <tr key={`${a.name}-${c.gateway}`}>
                        <td className="whitespace-nowrap">{a.name}</td>
                        <td>
                          <ExtLink href={c.url}>{c.gateway.replace(/^https?:\/\//, "")}</ExtLink>
                        </td>
                        <td>{c.status ?? "—"}</td>
                        <td className="text-right tabular-nums">
                          {c.bytes == null ? "—" : fmtInt(c.bytes)}
                        </td>
                        <td>
                          <Badge tone={c.matched ? "ok" : "bad"}>
                            {c.matched ? "match" : "no match"}
                          </Badge>
                        </td>
                        <td className="text-right tabular-nums">{(c.ms / 1000).toFixed(1)} s</td>
                        <td className="text-xs text-rose-700">{c.error ?? ""}</td>
                      </tr>
                    )),
                  )}
                  {v.rootPathCheck.map((c) => (
                    <tr key={`root-${c.gateway}`}>
                      <td className="whitespace-nowrap">(root path proof)</td>
                      <td>
                        <ExtLink href={c.url}>{c.gateway.replace(/^https?:\/\//, "")}</ExtLink>
                      </td>
                      <td>{c.status ?? "—"}</td>
                      <td className="text-right tabular-nums">
                        {c.bytes == null ? "—" : fmtInt(c.bytes)}
                      </td>
                      <td>
                        <Badge tone={c.matched ? "ok" : "bad"}>
                          {c.matched ? "match" : "no match"}
                        </Badge>
                      </td>
                      <td className="text-right tabular-nums">{(c.ms / 1000).toFixed(1)} s</td>
                      <td className="text-xs text-rose-700">{c.error ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <Notice>
            verification.json has not been written for this run yet. Use the “Verify now” buttons
            above for a live proof, or run the pipeline's verify stage.
          </Notice>
        )}
      </Section>

      <Section
        title="manifest.json (raw)"
        description="The machine-readable statement a third party needs to fetch the dataset by CID after this environment is gone."
      >
        <CopyBlock text={JSON.stringify(m, null, 2)} />
      </Section>
    </>
  );
}
