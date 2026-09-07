"use client";
import { useMemo, useState } from "react";
import type { QueryErrorResponse, QueryResponse } from "@/app/api/query/route";
import type { ApiError } from "@/app/api/_lib";
import { toCsv } from "@/lib/csv";
import { cellText as cell, fmtBytes, fmtInt } from "@/lib/format";
import type { PermitCoverage, QuerySchema } from "@/lib/mcp/tools";
import type { ExampleQuery } from "@/lib/queries/examples";
import { CopyBlock } from "./CopyBlock";

interface Props {
  schemas: { properties: QuerySchema | null; permits: QuerySchema | null };
  coverage: PermitCoverage | null;
  examples: readonly ExampleQuery[];
  endpoint: string;
  parquet: ReadonlyArray<{ name: string; cid: string; rowCount: number | null; size: number }>;
}

type Table = "properties" | "permits";

/** Schema browser + SQL editor + results grid with CSV download. Every run is a `queryProperties` / `queryPermits` MCP call. */
export function QueryConsole({ schemas, coverage, examples, endpoint, parquet }: Props) {
  const first = examples[0];
  const [table, setTable] = useState<Table>(first?.table ?? "properties");
  const [sql, setSql] = useState<string>(
    first?.sql ?? "SELECT count(*) AS properties FROM properties",
  );
  const [limit, setLimit] = useState<number>(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<(ApiError & Partial<QueryErrorResponse>) | null>(null);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [schemaTab, setSchemaTab] = useState<Table>("properties");
  const [filter, setFilter] = useState("");

  const schema = schemas[schemaTab];
  const columns = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (schema?.columns ?? []).filter(
      (c) => !f || c.name.includes(f) || (c.description ?? "").toLowerCase().includes(f),
    );
  }, [schema, filter]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ table, sql, limit }),
      });
      const body = (await res.json()) as QueryResponse | QueryErrorResponse;
      if (!res.ok || "error" in body) {
        setError("error" in body ? body : { error: `HTTP ${res.status}`, sql, hint: undefined });
        setResult(null);
      } else setResult(body);
    } catch (err) {
      setError({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const downloadCsv = () => {
    if (!result) return;
    const blob = new Blob([toCsv(result.rows, result.columns)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result.table}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_1fr]">
      <aside className="flex flex-col gap-4">
        <div className="card">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium">Schema browser</div>
            <div className="flex gap-1 text-xs">
              {(["properties", "permits"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setSchemaTab(t)}
                  className={`rounded px-2 py-0.5 ${schemaTab === t ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-zinc-100 dark:bg-zinc-800"}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="mb-1 text-xs text-zinc-500">
            {schema
              ? `view "${schema.view}" · ${schema.columnCount} columns · from ${schemaTab === "properties" ? "getPropertyQuerySchema" : "getPermitQuerySchema"}`
              : "schema unavailable (MCP offline)"}
          </div>
          <input
            className="input mb-2"
            placeholder="filter columns…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="max-h-[26rem] overflow-y-auto text-xs">
            {columns.map((c) => (
              <button
                key={c.name}
                type="button"
                className="block w-full border-t border-zinc-100 px-1 py-1 text-left hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800"
                title={c.description ?? ""}
                onClick={() => setSql((s) => (s.trim().length ? `${s} ${c.name}` : c.name))}
              >
                <span className="font-mono">{c.name}</span>{" "}
                <span className="text-zinc-400">{c.type}</span>
                {c.description ? (
                  <div className="truncate text-zinc-500">{c.description}</div>
                ) : null}
              </button>
            ))}
          </div>
        </div>
        {coverage ? (
          <div className="card text-xs">
            <div className="mb-1 text-sm font-medium">Permit coverage (getPermitCoverage)</div>
            {coverage.sources.map((s) => (
              <div
                key={s.source_system ?? "null"}
                className="flex justify-between border-t border-zinc-100 py-1 dark:border-zinc-800"
              >
                <span className="font-mono">{s.source_system ?? "—"}</span>
                <span className="tabular-nums">{fmtInt(s.permit_count)}</span>
              </div>
            ))}
            <div className="mt-1 text-zinc-500">total {fmtInt(coverage.totalPermits)} permits</div>
          </div>
        ) : null}
        <div className="card text-xs">
          <div className="mb-1 text-sm font-medium">What the MCP is reading</div>
          {parquet.map((p) => (
            <div key={p.name} className="border-t border-zinc-100 py-1 dark:border-zinc-800">
              <div className="flex justify-between">
                <span className="font-mono">{p.name.replace("query-tables/", "")}</span>
                <span className="text-zinc-500">
                  {p.rowCount == null ? "" : `${fmtInt(p.rowCount)} rows · `}
                  {fmtBytes(p.size)}
                </span>
              </div>
              <div className="mono truncate text-zinc-400" title={p.cid}>
                {p.cid}
              </div>
            </div>
          ))}
          <p className="mt-2 text-zinc-500">
            The MCP process embeds DuckDB and opens these Parquet files (locally or straight from an
            IPFS gateway URL). Nothing else is hosted: no Postgres, no warehouse, no always-on
            server beyond the MCP itself.
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="card">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <label className="text-sm">
              Tool{" "}
              <select
                className="input w-auto"
                value={table}
                onChange={(e) => setTable(e.target.value as Table)}
              >
                <option value="properties">queryProperties (view: properties)</option>
                <option value="permits">queryPermits (view: permits)</option>
              </select>
            </label>
            <label className="text-sm">
              Row cap{" "}
              <input
                type="number"
                className="input w-24"
                min={1}
                max={1000}
                value={limit}
                onChange={(e) =>
                  setLimit(Math.max(1, Math.min(1000, Number(e.target.value) || 100)))
                }
              />
            </label>
            <div className="ml-auto flex flex-wrap gap-1">
              <select
                className="input w-auto text-xs"
                defaultValue=""
                onChange={(e) => {
                  const ex = examples.find((x) => x.id === e.target.value);
                  if (ex) {
                    setTable(ex.table);
                    setSql(ex.sql);
                  }
                  e.target.value = "";
                }}
              >
                <option value="">Load example…</option>
                {examples.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void run()}
              >
                {busy ? "Running…" : "Run (⌘⏎)"}
              </button>
            </div>
          </div>
          <textarea
            className="input h-44 font-mono text-xs"
            spellCheck={false}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void run();
            }}
          />
          <div className="mt-1 text-xs text-zinc-500">
            One read-only SELECT (WITH … SELECT allowed). The MCP rejects mutations,
            multi-statements and file/extension keywords and caps rows at 1,000. Sent as{" "}
            <code>{table === "properties" ? "queryProperties" : "queryPermits"}</code> to{" "}
            <span className="font-mono">{endpoint}</span>.
          </div>
        </div>

        {error ? (
          <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
            <div className="font-medium">{error.error}</div>
            {error.details ? (
              <pre className="mt-1 whitespace-pre-wrap text-xs">{error.details}</pre>
            ) : (
              <div className="mt-1 text-xs">The MCP returned no further detail.</div>
            )}
            {error.sql ? (
              <details className="mt-2 text-xs" open>
                <summary className="cursor-pointer">SQL sent</summary>
                <pre className="mt-1 overflow-x-auto rounded bg-white/60 p-2 font-mono whitespace-pre-wrap dark:bg-black/30">
                  {error.sql}
                </pre>
              </details>
            ) : null}
            <div className="mt-2 text-xs">
              {error.hint ??
                "Only a single read-only SELECT (or WITH … SELECT) over the `properties` or `permits` view is accepted."}
            </div>
          </div>
        ) : null}

        {result ? (
          <div className="card min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <span>
                <strong>{fmtInt(result.rowCount)}</strong> row{result.rowCount === 1 ? "" : "s"}
                {result.rowCount >= result.limit ? (
                  <span className="text-amber-600"> (capped at {result.limit})</span>
                ) : null}{" "}
                · {result.ms} ms · via <code>{result.tool}</code>
              </span>
              <button
                type="button"
                className="btn ml-auto text-xs"
                onClick={downloadCsv}
                disabled={result.rows.length === 0}
              >
                Download CSV
              </button>
            </div>
            <div className="table-wrap max-h-[36rem]">
              <table>
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i}>
                      {result.columns.map((c) => (
                        <td
                          key={c}
                          className="max-w-[24rem] truncate font-mono text-xs"
                          title={cell(r[c])}
                        >
                          {cell(r[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3">
              <CopyBlock label="SQL as executed by the MCP" text={result.sql} />
            </div>
          </div>
        ) : null}

        <div className="card">
          <div className="mb-1 text-sm font-medium">Example queries (demo)</div>
          <ul className="space-y-1 text-sm">
            {examples.map((ex) => (
              <li key={ex.id} className="flex flex-wrap items-baseline gap-2">
                <button
                  type="button"
                  className="text-left text-emerald-700 underline decoration-emerald-300 underline-offset-2 dark:text-emerald-400"
                  onClick={() => {
                    setTable(ex.table);
                    setSql(ex.sql);
                  }}
                >
                  {ex.title}
                </button>
                <span className="text-xs text-zinc-500">
                  {ex.table} · {ex.note}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
