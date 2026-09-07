"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiError } from "@/app/api/_lib";
import { fmtDate, fmtDaysOpen, fmtInt, fmtMoney } from "@/lib/format";
import type { LeadPermit, LeadProperty, RadiusLeadsResult } from "@/lib/queries/leads";
import { fmtDaysOpen as daysOpen } from "@/lib/format";
import { CopyBlock } from "./CopyBlock";
import { Badge, ExtLink } from "./ui";

const LeadsMap = dynamic(() => import("./LeadsMap").then((m) => m.LeadsMap), {
  ssr: false,
  loading: () => (
    <div className="h-[60vh] animate-pulse rounded-lg bg-zinc-100 lg:h-full dark:bg-zinc-800" />
  ),
});

interface Place {
  name: string;
  lat: number;
  lng: number;
}

interface Props {
  places: Place[];
  defaults: { roofAgeYears: number; longOpenPermitYears: number; ownershipTenureYears: number };
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number };
}

interface Filters {
  radiusMiles: number;
  roofAgeYears: number;
  roofAgeOn: boolean;
  openRoofPermits: boolean;
  openYearsOn: boolean;
  openYears: number;
  ownerOutOfState: boolean;
  noSale10y: boolean;
  residentialOnly: boolean;
}

type LeadsResponse = RadiusLeadsResult & { ms: number };

interface Detail {
  property: LeadProperty | null;
  permits: LeadPermit[];
  sql: { property: string; permits: string };
}

/** Map + filters + results + property drawer. All data comes from `/api/leads` and `/api/property`, which call the MCP. */
export function LeadsExplorer({ places, defaults }: Props) {
  const kissimmee = places[0] ?? { name: "Kissimmee", lat: 28.2919, lng: -81.4076 };
  const [center, setCenter] = useState<{ lat: number; lng: number; label: string }>({
    ...kissimmee,
    label: kissimmee.name,
  });
  const [f, setF] = useState<Filters>({
    radiusMiles: 5,
    roofAgeYears: defaults.roofAgeYears,
    roofAgeOn: true,
    openRoofPermits: false,
    openYearsOn: false,
    openYears: defaults.longOpenPermitYears,
    ownerOutOfState: false,
    noSale10y: false,
    residentialOnly: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<LeadsResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [view, setView] = useState<"properties" | "permits">("properties");
  const [permitRes, setPermitRes] = useState<{
    sql: string;
    permits: LeadPermit[];
    ms: number;
  } | null>(null);
  const [permitBusy, setPermitBusy] = useState(false);
  const [permitContractorOnly, setPermitContractorOnly] = useState(false);

  const search = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        lat: center.lat,
        lng: center.lng,
        radiusMiles: f.radiusMiles,
        minRoofAgeYears: f.roofAgeOn ? f.roofAgeYears : null,
        openRoofPermits: f.openRoofPermits || f.openYearsOn,
        openRoofPermitMinYears: f.openYearsOn ? f.openYears : null,
        ownerOutOfState: f.ownerOutOfState,
        minYearsSinceSale: f.noSale10y ? defaults.ownershipTenureYears : null,
        propertyTypes: f.residentialOnly ? ["residential"] : undefined,
        limit: 500,
      };
      const r = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as LeadsResponse | ApiError;
      if (!r.ok || "error" in data) {
        setError(
          "error" in data
            ? `${data.error}${data.details ? ` — ${data.details}` : ""}`
            : `HTTP ${r.status}`,
        );
        setRes(null);
      } else setRes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
    setPermitBusy(true);
    try {
      const r = await fetch("/api/permits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lat: center.lat,
          lng: center.lng,
          radiusMiles: f.radiusMiles,
          minDaysOpen: f.openYearsOn ? Math.round(f.openYears * 365.25) : null,
          requireContractor: permitContractorOnly,
          limit: 200,
        }),
      });
      const data = (await r.json()) as
        { sql: string; permits: LeadPermit[]; ms: number } | ApiError;
      setPermitRes("error" in data ? null : data);
    } catch {
      setPermitRes(null);
    } finally {
      setPermitBusy(false);
    }
  }, [center, f, defaults.ownershipTenureYears, permitContractorOnly]);

  useEffect(() => {
    void search();
    // initial load only
  }, []);

  const openDetail = useCallback(async (parcel: string) => {
    setSelected(parcel);
    setDetailBusy(true);
    try {
      const r = await fetch(`/api/property?parcel=${encodeURIComponent(parcel)}`);
      const data = (await r.json()) as Detail | ApiError;
      setDetail("error" in data ? null : data);
    } finally {
      setDetailBusy(false);
    }
  }, []);

  const sorted = useMemo(() => {
    const list = [...(res?.properties ?? [])];
    if (f.openRoofPermits || f.openYearsOn)
      list.sort(
        (a, b) =>
          (b.oldestOpenRoofPermitDays ?? 0) - (a.oldestOpenRoofPermitDays ?? 0) ||
          (a.distanceMiles ?? 0) - (b.distanceMiles ?? 0),
      );
    return list;
  }, [res, f.openRoofPermits, f.openYearsOn]);

  const stats = useMemo(() => {
    const ps = res?.properties ?? [];
    const permits = Object.values(res?.permitsByParcel ?? {}).flat();
    const openRoof = permits.filter((p) => p.isOpen);
    return {
      total: ps.length,
      byPermit: ps.filter((p) => p.roofAgeBasis === "roof_permit").length,
      byBuilt: ps.filter((p) => p.roofAgeBasis === "built_year").length,
      openRoofPermits: openRoof.length,
      longestOpen: openRoof.reduce((m, p) => Math.max(m, p.daysOpen ?? 0), 0),
      withContractor: openRoof.filter((p) => p.contractorName).length,
      withBbb: openRoof.filter((p) => p.bbbRating).length,
    };
  }, [res]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]">
      <aside className="flex flex-col gap-3">
        <div className="card">
          <div className="mb-2 text-sm font-medium">Where</div>
          <div className="mb-2 flex flex-wrap gap-1">
            {places.map((p) => (
              <button
                key={p.name}
                type="button"
                className={`btn text-xs ${center.label === p.name ? "btn-primary" : ""}`}
                onClick={() => setCenter({ ...p, label: p.name })}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="text-xs text-zinc-500">
            Pin: {center.label} · {center.lat.toFixed(5)}, {center.lng.toFixed(5)}
          </div>
          <label className="mt-3 block text-sm">
            Radius <strong>{f.radiusMiles} mi</strong>
            <input
              type="range"
              min={1}
              max={15}
              step={1}
              value={f.radiusMiles}
              onChange={(e) => setF({ ...f, radiusMiles: Number(e.target.value) })}
              className="w-full"
            />
          </label>
        </div>
        <div className="card">
          <div className="mb-2 text-sm font-medium">Roof age</div>
          <label className="flex flex-wrap items-center gap-2 text-sm whitespace-nowrap">
            <input
              type="checkbox"
              checked={f.roofAgeOn}
              onChange={(e) => setF({ ...f, roofAgeOn: e.target.checked })}
            />
            Roof older than
            <input
              type="number"
              className="input w-20"
              min={0}
              max={120}
              value={f.roofAgeYears}
              onChange={(e) => setF({ ...f, roofAgeYears: Number(e.target.value) || 0 })}
            />
            years
          </label>
          <p className="mt-1 text-xs text-zinc-500">
            roof_age_years = years since the last roofing permit when one exists (basis
            roof_permit), otherwise since built_year. Parcels with neither are excluded.
          </p>
        </div>
        <div className="card">
          <div className="mb-2 text-sm font-medium">Permits & ownership</div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={f.openRoofPermits}
              onChange={(e) => setF({ ...f, openRoofPermits: e.target.checked })}
            />{" "}
            Open roofing permits
          </label>
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={f.openYearsOn}
              onChange={(e) => setF({ ...f, openYearsOn: e.target.checked })}
            />{" "}
            Open &gt;
            <input
              type="number"
              className="input w-16"
              min={0}
              max={40}
              value={f.openYears}
              onChange={(e) => setF({ ...f, openYears: Number(e.target.value) || 0 })}
            />{" "}
            years
          </label>
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={f.ownerOutOfState}
              onChange={(e) => setF({ ...f, ownerOutOfState: e.target.checked })}
            />{" "}
            Owner out of state
          </label>
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={f.noSale10y}
              onChange={(e) => setF({ ...f, noSale10y: e.target.checked })}
            />{" "}
            No sale in {defaults.ownershipTenureYears}+ years
          </label>
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={f.residentialOnly}
              onChange={(e) => setF({ ...f, residentialOnly: e.target.checked })}
            />{" "}
            Residential only
          </label>
          <button
            type="button"
            className="btn btn-primary mt-3 w-full justify-center"
            disabled={busy}
            onClick={() => void search()}
          >
            {busy ? "Querying MCP…" : "Search"}
          </button>
        </div>
        {res ? (
          <div className="card text-sm">
            <div className="mb-1 font-medium">
              {fmtInt(res.total)} propert{res.total === 1 ? "y" : "ies"} match
              {res.truncated ? (
                <span className="ml-1 text-xs text-amber-600">
                  · showing the {fmtInt(stats.total)} oldest roofs on the map (narrow the radius for
                  all)
                </span>
              ) : null}
            </div>
            <div className="text-xs text-zinc-500">
              roof age basis: {fmtInt(stats.byPermit)} from a roofing permit ·{" "}
              {fmtInt(stats.byBuilt)} from year built
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              open roofing permits on these parcels: {fmtInt(stats.openRoofPermits)}
              {stats.openRoofPermits
                ? ` · longest ${fmtDaysOpen(stats.longestOpen)} · ${stats.withContractor} with contractor · ${stats.withBbb} with BBB rating`
                : ""}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              {res.ms} ms · queryProperties ×2 (list + count)
              {res.longOpenPermitsSql ? " · queryPermits (long-open parcels)" : ""} + queryPermits
              (permits on parcels)
            </div>
            <button
              type="button"
              className="mt-2 text-xs text-emerald-700 underline dark:text-emerald-400"
              onClick={() => setShowSql((s) => !s)}
            >
              {showSql ? "Hide" : "Show"} SQL sent to the MCP
            </button>
            {showSql ? (
              <div className="mt-2 space-y-2">
                {res.longOpenPermitsSql ? (
                  <CopyBlock
                    label="queryPermits — parcels with roofing permits open > N years"
                    text={res.longOpenPermitsSql}
                  />
                ) : null}
                <CopyBlock label="queryProperties — list" text={res.sql} />
                <CopyBlock label="queryProperties — count" text={res.countSql} />
                {res.permitsSql ? (
                  <CopyBlock
                    label="queryPermits — roofing permits on the listed parcels"
                    text={res.permitsSql}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
            {error}
          </div>
        ) : null}
      </aside>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="min-h-[60vh] lg:h-[60vh]">
          <LeadsMap
            center={center}
            radiusMiles={f.radiusMiles}
            properties={sorted}
            selected={selected}
            onPick={(lat, lng) => setCenter({ lat, lng, label: "dropped pin" })}
            onSelect={(p) => void openDetail(p)}
          />
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-600" /> aged roof
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-600" /> 25+ years
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-rose-600" /> open roofing
            permit
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-blue-600" /> search pin
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button
            type="button"
            className={`btn ${view === "properties" ? "btn-primary" : ""}`}
            onClick={() => setView("properties")}
          >
            Properties ({fmtInt(res?.total ?? 0)})
          </button>
          <button
            type="button"
            className={`btn ${view === "permits" ? "btn-primary" : ""}`}
            onClick={() => setView("permits")}
          >
            Open roofing permits in radius ({fmtInt(permitRes?.permits.length ?? 0)})
          </button>
          {view === "permits" ? (
            <label className="ml-2 flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={permitContractorOnly}
                onChange={(e) => {
                  setPermitContractorOnly(e.target.checked);
                }}
              />
              only permits naming a contractor (re-run Search)
            </label>
          ) : null}
          <span className="ml-auto text-xs text-zinc-500">
            {view === "permits"
              ? "Longest open first · contractor, license, phone, BBB rating and source per permit"
              : "Oldest roof first · click a row for the full record and its permits"}
          </span>
        </div>

        <div
          className={`grid min-w-0 grid-cols-1 gap-3 ${view === "properties" ? "xl:grid-cols-[1fr_26rem]" : ""}`}
        >
          {view === "permits" ? (
            <PermitsTable
              permits={permitRes?.permits ?? []}
              busy={permitBusy}
              sql={permitRes?.sql ?? null}
              selected={selected}
              onSelect={(p) => void openDetail(p)}
            />
          ) : (
            <div className="table-wrap max-h-[32rem] min-w-0">
              <table>
                <thead>
                  <tr>
                    <th>Address</th>
                    <th className="text-right">Dist</th>
                    <th className="text-right">Roof age</th>
                    <th>Basis</th>
                    <th className="text-right">Built</th>
                    <th>Open roof permit</th>
                    <th>Owner</th>
                    <th>Last sale</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((p) => {
                    const permits = res?.permitsByParcel[p.parcelIdentifier] ?? [];
                    const open = permits.filter((x) => x.isOpen);
                    return (
                      <tr
                        key={p.parcelIdentifier}
                        className={`cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800 ${selected === p.parcelIdentifier ? "bg-emerald-50 dark:bg-emerald-950/30" : ""}`}
                        onClick={() => void openDetail(p.parcelIdentifier)}
                      >
                        <td>
                          <div className="font-medium">{p.addressStreet ?? "(no situs)"}</div>
                          <div className="text-xs text-zinc-500">
                            {p.addressCity} {p.addressZip} ·{" "}
                            <span className="font-mono">{p.parcelIdentifier}</span>
                          </div>
                        </td>
                        <td className="text-right tabular-nums">
                          {p.distanceMiles?.toFixed(2)} mi
                        </td>
                        <td className="text-right font-semibold tabular-nums">
                          {p.roofAgeYears ?? "—"} y
                        </td>
                        <td className="text-xs">
                          {p.roofAgeBasis === "roof_permit" ? (
                            <Badge tone="ok">permit {fmtDate(p.lastRoofPermitDate)}</Badge>
                          ) : p.roofAgeBasis === "built_year" ? (
                            <Badge tone="muted">year built</Badge>
                          ) : (
                            <Badge tone="warn">unknown</Badge>
                          )}
                        </td>
                        <td className="text-right tabular-nums">{p.builtYear ?? "—"}</td>
                        <td className="text-xs">
                          {open.length ? (
                            <span>
                              <Badge tone="bad">{open.length} open</Badge>{" "}
                              {fmtDaysOpen(open[0]?.daysOpen)}
                              {open[0]?.contractorName ? (
                                <div className="truncate">{open[0].contractorName}</div>
                              ) : null}
                            </span>
                          ) : p.openRoofPermitCount > 0 ? (
                            <Badge tone="warn">{p.openRoofPermitCount} (flag)</Badge>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="max-w-[12rem] truncate text-xs" title={p.ownersText ?? ""}>
                          {p.ownerName ?? "—"}
                          {p.ownerOutOfState ? <Badge tone="warn">out of state</Badge> : null}
                        </td>
                        <td className="text-xs whitespace-nowrap">
                          {fmtDate(p.lastSaleDate)}
                          {p.yearsSinceSale != null ? (
                            <div className="text-zinc-500">{p.yearsSinceSale.toFixed(1)} y ago</div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                  {sorted.length === 0 && !busy ? (
                    <tr>
                      <td colSpan={8} className="py-6 text-center text-zinc-500">
                        No properties match. Widen the radius or relax a filter.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}

          <PropertyDrawer detail={detail} busy={detailBusy} onClose={() => setSelected(null)} />
        </div>
      </div>
    </div>
  );
}

function PermitsTable({
  permits,
  busy,
  sql,
  selected,
  onSelect,
}: {
  permits: LeadPermit[];
  busy: boolean;
  sql: string | null;
  selected: string | null;
  onSelect: (parcel: string) => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="min-w-0">
      <div className="table-wrap max-h-[32rem]">
        <table>
          <thead>
            <tr>
              <th>Permit</th>
              <th className="text-right">Open for</th>
              <th>Issued</th>
              <th>Job site</th>
              <th>Contractor</th>
              <th>BBB</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {permits.map((x) => (
              <tr
                key={x.permitId}
                className={`cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800 ${selected === x.parcelIdentifier ? "bg-emerald-50 dark:bg-emerald-950/30" : ""}`}
                onClick={() => x.parcelIdentifier && onSelect(x.parcelIdentifier)}
              >
                <td>
                  <div className="font-mono text-xs font-medium">{x.permitNumber}</div>
                  <div className="text-xs text-zinc-500">
                    <Badge tone="bad">{x.status ?? "open"}</Badge>{" "}
                    {x.issuingAgency ?? x.sourceSystem}
                  </div>
                </td>
                <td className="text-right font-semibold tabular-nums whitespace-nowrap">
                  {daysOpen(x.daysOpen)}
                </td>
                <td className="text-xs whitespace-nowrap">
                  {fmtDate(x.issueDate ?? x.openedDate)}
                </td>
                <td className="text-xs">
                  <div>{x.addressStreet}</div>
                  <div className="text-zinc-500">
                    {x.addressCity} · {x.distanceMiles?.toFixed(2)} mi
                  </div>
                </td>
                <td className="max-w-[14rem] text-xs">
                  {x.contractorName ? (
                    <>
                      <div className="truncate font-medium" title={x.contractorName}>
                        {x.contractorName}
                      </div>
                      <div className="text-zinc-500">
                        {x.contractorQualifier ? `${x.contractorQualifier} · ` : ""}
                        {x.contractorLicense ? `lic. ${x.contractorLicense} · ` : ""}
                        {x.contractorPhone ?? ""}
                      </div>
                    </>
                  ) : (
                    <span className="text-zinc-400">not recorded on permit</span>
                  )}
                </td>
                <td className="text-xs">
                  {x.bbbRating ? (
                    <Badge tone="ok">{x.bbbRating}</Badge>
                  ) : (
                    <span className="text-zinc-400">none matched</span>
                  )}
                </td>
                <td className="max-w-[10rem] truncate text-xs">
                  {x.sourceUrl ? (
                    <ExtLink href={x.sourceUrl}>{x.sourceUrl.replace(/^https?:\/\//, "")}</ExtLink>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
            {permits.length === 0 && !busy ? (
              <tr>
                <td colSpan={7} className="py-6 text-center text-zinc-500">
                  No open roofing permits in this radius with the current filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {sql ? (
        <div className="mt-2">
          <button
            type="button"
            className="text-xs text-emerald-700 underline dark:text-emerald-400"
            onClick={() => setShow((s) => !s)}
          >
            {show ? "Hide" : "Show"} SQL (queryPermits)
          </button>
          {show ? <CopyBlock text={sql} className="mt-1" /> : null}
        </div>
      ) : null}
    </div>
  );
}

function PropertyDrawer({
  detail,
  busy,
  onClose,
}: {
  detail: Detail | null;
  busy: boolean;
  onClose: () => void;
}) {
  if (busy)
    return (
      <div className="card animate-pulse text-sm text-zinc-500">Loading property from the MCP…</div>
    );
  if (!detail?.property)
    return (
      <div className="card text-sm text-zinc-500">
        Select a marker or a row to see the property, its roof-age basis, owner and permits with
        contractor and BBB rating.
      </div>
    );
  const p = detail.property;
  const roofing = detail.permits.filter((x) => x.isRoofing);
  const others = detail.permits.filter((x) => !x.isRoofing);
  return (
    <div className="card max-h-[40rem] overflow-y-auto text-sm">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-base font-semibold">{p.addressStreet ?? "(no situs)"}</div>
          <div className="text-xs text-zinc-500">
            {p.addressCity} {p.addressZip} · {p.propertyUsageType} · parcel{" "}
            <span className="font-mono">{p.parcelIdentifier}</span>
          </div>
        </div>
        <button type="button" className="btn text-xs" onClick={onClose}>
          Close
        </button>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-zinc-500">Roof age</dt>
        <dd>
          <strong>{p.roofAgeYears ?? "unknown"} years</strong> — basis <code>{p.roofAgeBasis}</code>
          {p.roofAgeBasis === "roof_permit"
            ? ` (last roofing permit ${fmtDate(p.lastRoofPermitDate)})`
            : p.roofAgeBasis === "built_year"
              ? ` (year built ${p.builtYear}, effective ${p.effectiveYear ?? "—"})`
              : " (no year built or roofing permit on record)"}
        </dd>
        <dt className="text-zinc-500">Coordinates</dt>
        <dd className="font-mono">
          {p.latitude.toFixed(6)}, {p.longitude.toFixed(6)}{" "}
          <span className="font-sans text-zinc-500">(parcel centroid, county GIS)</span>
        </dd>
        <dt className="text-zinc-500">Owner</dt>
        <dd>
          {p.ownersText ?? "—"}
          <div className="text-zinc-500">
            mails to {p.ownerMailCity ?? "—"}, {p.ownerMailState ?? "—"} ·{" "}
            {p.ownerOccupied ? "owner-occupied" : "not owner-occupied"}
            {p.ownerOutOfState ? " · out of state" : p.ownerOutOfCounty ? " · out of county" : ""}
          </div>
        </dd>
        <dt className="text-zinc-500">Last sale</dt>
        <dd>
          {fmtDate(p.lastSaleDate)} · {fmtMoney(p.lastSalePrice)}
          {p.yearsSinceSale != null ? ` · ${p.yearsSinceSale.toFixed(1)} years ago` : ""}
        </dd>
        <dt className="text-zinc-500">Value / area</dt>
        <dd>
          market {fmtMoney(p.marketValue)} ·{" "}
          {p.livableFloorArea ? `${fmtInt(p.livableFloorArea)} sq ft heated` : "area n/a"}
        </dd>
        <dt className="text-zinc-500">Sources</dt>
        <dd className="flex flex-col">
          {p.sourceUrls.map((u) => (
            <ExtLink key={u} href={u}>
              {u.replace(/^https?:\/\//, "").slice(0, 60)}
            </ExtLink>
          ))}
          <span className="text-zinc-500">last changed in run {p.lastChangedRunId}</span>
        </dd>
      </dl>

      <div className="mt-3 mb-1 font-medium">
        Roofing permits ({roofing.length}){" "}
        <span className="text-xs font-normal text-zinc-500">
          · {p.permitCount} permits total on parcel
        </span>
      </div>
      {roofing.length === 0 ? (
        <div className="text-xs text-zinc-500">No roofing permit on record for this parcel.</div>
      ) : null}
      <div className="space-y-2">
        {roofing.map((x) => (
          <PermitCard key={x.permitId} permit={x} />
        ))}
      </div>
      {others.length ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-zinc-500">
            Other permits ({others.length})
          </summary>
          <div className="mt-2 space-y-2">
            {others.map((x) => (
              <PermitCard key={x.permitId} permit={x} />
            ))}
          </div>
        </details>
      ) : null}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-zinc-500">SQL used</summary>
        <div className="mt-2 space-y-2">
          <CopyBlock label="queryProperties" text={detail.sql.property} />
          <CopyBlock label="queryPermits" text={detail.sql.permits} />
        </div>
      </details>
    </div>
  );
}

function PermitCard({ permit: x }: { permit: LeadPermit }) {
  return (
    <div className="rounded-md border border-zinc-200 p-2 text-xs dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-1">
        <span className="font-mono font-medium">{x.permitNumber}</span>
        <Badge tone={x.isOpen ? "bad" : x.status === "voided" ? "muted" : "ok"}>
          {x.status ?? "unknown"}
        </Badge>
        {x.isRoofing ? (
          <Badge tone="warn">roofing</Badge>
        ) : (
          <Badge tone="muted">{x.improvementType ?? "permit"}</Badge>
        )}
        <span className="text-zinc-500">{x.issuingAgency ?? x.sourceSystem}</span>
      </div>
      <div className="mt-1 text-zinc-600 dark:text-zinc-300">
        issued {fmtDate(x.issueDate ?? x.openedDate)} ·{" "}
        {x.isOpen
          ? `open for ${fmtDaysOpen(x.daysOpen)}`
          : `closed ${fmtDate(x.closeDate ?? x.completionDate ?? x.finalInspectionDate)}`}
        {x.estimatedJobValue ? ` · ${fmtMoney(x.estimatedJobValue)}` : ""}
      </div>
      {x.description ? (
        <div className="mt-0.5 truncate text-zinc-500" title={x.description}>
          {x.description}
        </div>
      ) : null}
      <div className="mt-1">
        <span className="text-zinc-500">Contractor:</span>{" "}
        {x.contractorName ?? <span className="text-zinc-400">not recorded on permit</span>}
        {x.contractorQualifier ? (
          <span className="text-zinc-500"> · qualifier {x.contractorQualifier}</span>
        ) : null}
        {x.contractorPhone ? <span> · {x.contractorPhone}</span> : null}
        {x.contractorLicense ? <span> · lic. {x.contractorLicense}</span> : null}
      </div>
      <div>
        <span className="text-zinc-500">BBB:</span>{" "}
        {x.bbbRating ? (
          <span>
            <Badge tone="ok">{x.bbbRating}</Badge> {x.bbbAccredited ? "accredited" : ""}{" "}
            {x.bbbProfileUrl ? <ExtLink href={x.bbbProfileUrl}>profile</ExtLink> : null}{" "}
            <span className="text-zinc-500">matched by {x.bbbMatchMethod}</span>
          </span>
        ) : (
          <span className="text-zinc-400">no rating matched in this run</span>
        )}
      </div>
      {x.sourceUrl ? (
        <div className="truncate">
          <span className="text-zinc-500">Source:</span>{" "}
          <ExtLink href={x.sourceUrl}>{x.sourceUrl.replace(/^https?:\/\//, "")}</ExtLink>{" "}
          <span className="text-zinc-500">fetched {fmtDate(x.fetchedAt)}</span>
        </div>
      ) : null}
    </div>
  );
}
