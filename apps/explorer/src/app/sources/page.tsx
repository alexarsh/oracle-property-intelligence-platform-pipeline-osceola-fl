import { OSCEOLA } from "@osceola/shared";
import { CoverageBar, ExtLink, Notice, PageHeader, Section, Stat } from "@/components/ui";
import { loadArtifacts } from "@/lib/artifacts";
import { fmtBytes, fmtDateTime, fmtInt } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const snap = await loadArtifacts();
  const run = snap.latest;
  const cov = run?.coverage ?? null;
  if (!run || !cov) {
    return (
      <>
        <PageHeader
          title="Sources & coverage"
          transcript="Show the total uploaded records by source."
        />
        <Notice tone="bad">
          coverage.json not found for the latest run. {snap.warnings.join(" ")}
        </Notice>
      </>
    );
  }
  const permitsTable = cov.tables.find((t) => t.table === "permits");
  const contractorsTable = cov.tables.find((t) => t.table === "contractors");
  const bbbCol = contractorsTable?.columns.find((c) => c.column === "bbb_rating");
  const permitBbb = permitsTable?.columns.find((c) => c.column === "bbb_rating");
  const geoCol = cov.tables
    .find((t) => t.table === "properties")
    ?.columns.find((c) => c.column === "latitude");
  const ownerCol = cov.tables
    .find((t) => t.table === "properties")
    ?.columns.find((c) => c.column === "owner_name");
  const totalBytes = cov.sourceLoads.reduce((s, l) => s + (l.bytes ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Sources & coverage"
        transcript="Show the total uploaded records by source."
      >
        <div className="text-sm text-zinc-500">
          run <span className="font-mono">{cov.runId}</span> · exported{" "}
          {fmtDateTime(cov.exportedAt)}
        </div>
      </PageHeader>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Properties"
          value={fmtInt(cov.tables.find((t) => t.table === "properties")?.rows)}
          sub="appraiser roll, one row per folio"
        />
        <Stat label="Permits" value={fmtInt(permitsTable?.rows)} sub="all agencies, deduplicated" />
        <Stat
          label="Ownership"
          value={fmtInt(ownerCol?.nonNull)}
          sub={`owner_name present · ${ownerCol ? ownerCol.pct.toFixed(1) : "—"}%`}
        />
        <Stat
          label="Contractors"
          value={fmtInt(contractorsTable?.rows)}
          sub="reconciled entities (license › phone › name)"
        />
        <Stat
          label="BBB-rated"
          value={fmtInt(bbbCol?.nonNull ?? 0)}
          sub={`contractors with a rating · ${permitBbb ? fmtInt(permitBbb.nonNull) : "—"} permits`}
        />
        <Stat
          label="Coordinates"
          value={fmtInt(geoCol?.nonNull)}
          sub={`parcel centroids · ${geoCol ? geoCol.pct.toFixed(1) : "—"}% of properties`}
        />
      </div>

      {(bbbCol?.nonNull ?? 0) === 0 ? (
        <Notice>
          BBB ratings: no contractor carries a rating in this run. The BBB crawl (
          {OSCEOLA.sources.bbb_roofing?.label}) is geo-blocked outside the US and bot-challenged;
          ratings populate <code>bbb_rating</code> on contractors and permits once a US-egress
          harvest lands. The UI, queries and agent already surface the column and say “not
          available” rather than inventing a score.
        </Notice>
      ) : null}

      <Section
        title="Datasets loaded"
        description="Per-source ingestion counters from the DuckDB dataset ledger (what the pipeline considers loaded), with first/last load timestamps."
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th className="text-right">Ingested</th>
                <th className="text-right">Expected</th>
                <th>First loaded</th>
                <th>Last loaded</th>
                <th>CID / IPNS label</th>
              </tr>
            </thead>
            <tbody>
              {cov.datasets.map((d) => (
                <tr key={d.source}>
                  <td className="font-medium">{d.source}</td>
                  <td className="text-right tabular-nums">{fmtInt(d.ingested_count)}</td>
                  <td className="text-right tabular-nums">
                    {d.expected_count == null ? (
                      <span className="text-zinc-500">unknown</span>
                    ) : (
                      fmtInt(d.expected_count)
                    )}
                  </td>
                  <td className="text-xs whitespace-nowrap">
                    {fmtDateTime(
                      d.first_loaded_at ? d.first_loaded_at.replace(" ", "T") + "Z" : null,
                    )}
                  </td>
                  <td className="text-xs whitespace-nowrap">
                    {fmtDateTime(
                      d.last_loaded_at ? d.last_loaded_at.replace(" ", "T") + "Z" : null,
                    )}
                  </td>
                  <td className="mono">
                    {d.cid ?? d.ipns_label ?? (
                      <span className="text-zinc-500">published under the run root</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Source catalog"
        description="Every public source the county config declares, how it is read, how often the custodian refreshes it, and its known limitations. This is the provenance of every row."
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {Object.values(OSCEOLA.sources).map((s) => {
            const loads = cov.sourceLoads.filter((l) => l.source === s.key);
            const rows = loads.reduce((n, l) => n + (l.rows ?? 0), 0);
            return (
              <div key={s.key} className="card">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{s.label}</div>
                    <div className="text-xs text-zinc-500">
                      {s.custodian} · {s.accessMode} · cadence {s.cadence} · key{" "}
                      <code>{s.key}</code>
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    <div className="font-semibold tabular-nums">
                      {loads.length ? fmtInt(rows) : "0"}
                    </div>
                    <div className="text-xs text-zinc-500">
                      {loads.length
                        ? `${loads.length} load${loads.length === 1 ? "" : "s"} this run`
                        : "not loaded this run"}
                    </div>
                  </div>
                </div>
                <div className="mt-1 text-xs">
                  <ExtLink href={s.url}>{s.url}</ExtLink>
                </div>
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-zinc-600 dark:text-zinc-300">
                  {s.limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </Section>

      <Section
        title="Source-load ledger"
        description={`Every file or request batch read this run: URL, SHA-256 digest of the bytes, size, rows and fetch time. ${fmtBytes(totalBytes)} in total.`}
      >
        <div className="table-wrap max-h-[28rem]">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Item</th>
                <th>URL</th>
                <th>Digest (sha256)</th>
                <th className="text-right">Bytes</th>
                <th className="text-right">Rows</th>
                <th>Fetched at</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {cov.sourceLoads.map((l, i) => (
                <tr key={`${l.source}-${l.item ?? i}`}>
                  <td className="whitespace-nowrap">{l.source}</td>
                  <td className="text-xs">{l.item ?? "—"}</td>
                  <td className="max-w-xs truncate text-xs">
                    {l.url ? (
                      <ExtLink href={l.url}>
                        {l.url.replace(/^https?:\/\//, "").slice(0, 60)}…
                      </ExtLink>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="mono max-w-[10rem] truncate" title={l.digest ?? ""}>
                    {l.digest ?? "—"}
                  </td>
                  <td className="text-right tabular-nums whitespace-nowrap">{fmtBytes(l.bytes)}</td>
                  <td className="text-right tabular-nums">{fmtInt(l.rows)}</td>
                  <td className="text-xs whitespace-nowrap">
                    {fmtDateTime(l.fetched_at ? l.fetched_at.replace(" ", "T") + "Z" : null)}
                  </td>
                  <td className="text-xs">{l.notes ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Column coverage per query table"
        description="Share of rows with a non-null value. Kit-schema columns that Osceola cannot populate (exterior_wall_material, roof_covering_material, avm_value, has_sunbiz_tenant, hoa_flag) are deliberately NULL and stated as such rather than guessed."
      >
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          {cov.tables.map((t) => (
            <div key={t.table} className="card">
              <div className="mb-2 flex items-baseline justify-between">
                <div className="font-medium">{t.table}</div>
                <div className="text-xs text-zinc-500">{fmtInt(t.rows)} rows</div>
              </div>
              <div className="max-h-[32rem] overflow-y-auto pr-1">
                <table className="w-full text-xs">
                  <tbody>
                    {t.columns.map((c) => (
                      <tr key={c.column} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className="py-1 font-mono">{c.column}</td>
                        <td className="py-1 text-right text-zinc-500 tabular-nums">
                          {fmtInt(c.nonNull)}
                        </td>
                        <td className="py-1 pl-2">
                          <CoverageBar pct={c.pct} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
