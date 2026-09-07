import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccelaHarvestSummary, AccelaPermitRecord } from "@osceola/shared";
import { afterEach, describe, expect, it } from "vitest";
import { bisectWindow, harvestRange, harvestWindow } from "./harvest.js";

const fixtures = new URL("./__fixtures__/", import.meta.url);
const deltaPage1 = readFileSync(new URL("search-delta-page1.txt", fixtures), "utf8");
const detailHtml = readFileSync(new URL("cap-detail-roofing.html", fixtures), "utf8");

/** Page 2 fixture: same rows, no further pager link, "Showing 11-20 of 100+". */
const deltaPage2 = deltaPage1
  .replace("Showing 1-10 of 100+", "Showing 11-20 of 100+")
  .replace(/<td class="aca_pagination_td[\s\S]*?<\/tr>/, "</tr>")
  .replace(/capID3=00U/g, "capID3=P2U")
  .replace(/A26-00(\d{4})/g, "A26-P2$1"); // distinct record numbers, otherwise the harvester dedupes them
/** Uncapped single-page variant. */
const deltaSmall = deltaPage1.replace("Showing 1-10 of 100+", "Showing 1-10 of 10").replace(/<td class="aca_pagination_td[\s\S]*?<\/tr>/, "</tr>");

const homeHtml = '<html><body><form><input type="hidden" name="__VIEWSTATE" value="vs0" /><input type="hidden" name="__VIEWSTATEGENERATOR" value="A9414CD7" /></form></body></html>';

interface FakePortalOptions {
  /** Called for every request; return a Response to override the default routing. */
  intercept?: (url: string, init: RequestInit, calls: string[]) => Response | undefined;
  /** Serve `deltaSmall` (uncapped) for windows whose span is a single day. */
  bisect?: boolean;
}

function fakePortal(options: FakePortalOptions = {}): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const route = (input: string | URL | Request, init?: RequestInit): Response => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url} ${body ? (new URLSearchParams(body).get("__EVENTTARGET") ?? "") : ""}`.trim());
    const override = options.intercept?.(url, init ?? {}, calls);
    if (override) return override;

    if (url.includes("CapHome.aspx") && method === "GET") {
      return new Response(homeHtml, { status: 200, headers: { "set-cookie": "ASP.NET_SessionId=abc; path=/" } });
    }
    if (url.includes("CapHome.aspx") && method === "POST") {
      const form = new URLSearchParams(body);
      expect(init?.headers).toMatchObject({ "X-MicrosoftAjax": "Delta=true", Cookie: "ASP.NET_SessionId=abc" });
      const target = form.get("__EVENTTARGET") ?? "";
      if (target.endsWith("ctl13$ctl03")) {
        expect(form.get("__VIEWSTATE")).toHaveLength(266496); // carried forward from the page-1 delta
        return new Response(deltaPage2, { status: 200 });
      }
      expect(form.get("ctl00$PlaceHolderMain$btnNewSearch")).toBe("Search");
      expect(form.get("ctl00$PlaceHolderMain$generalSearchForm$ddlGSPermitType")).toBe("Building/Permit/Roofing/NA");
      if (options.bisect) {
        const single = form.get("ctl00$PlaceHolderMain$generalSearchForm$txtGSStartDate") === form.get("ctl00$PlaceHolderMain$generalSearchForm$txtGSEndDate");
        return new Response(single ? deltaSmall : deltaPage1, { status: 200 });
      }
      return new Response(deltaPage1, { status: 200 });
    }
    if (url.includes("CapDetail.aspx")) {
      const capID3 = new URL(url).searchParams.get("capID3") ?? "X";
      return new Response(detailHtml.replaceAll("A26-006405", `A26-${capID3}`), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(route(input, init))) as typeof fetch;
  return { fetchImpl, calls };
}

const readJsonl = <T,>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "accela-harvest-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const base = { since: "2026-09-01", until: "2026-09-07", minDelayMs: 0, retryBaseDelayMs: 1 };

describe("harvestWindow", () => {
  it("pages through a capped window, fetches details and writes validated artifacts", async () => {
    const outDir = tmp();
    const portal = fakePortal();
    const summary = await harvestWindow({ ...base, outDir, fetchImpl: portal.fetchImpl });

    expect(AccelaHarvestSummary.parse(summary)).toMatchObject({
      window: { since: "2026-09-01", until: "2026-09-07" },
      recordType: "Building/Permit/Roofing/NA",
      searchHits: 20,
      capped: true,
      detailsFetched: 14,
      detailsFailed: 0,
    });
    // 1 GET home + 2 search postbacks + 14 details
    expect(summary.requestCount).toBe(17);
    expect(summary.p95LatencyMs).toBeGreaterThanOrEqual(summary.p50LatencyMs);

    const permits = readJsonl<AccelaPermitRecord>(path.join(outDir, "permits.jsonl"));
    expect(permits).toHaveLength(14);
    for (const p of permits) AccelaPermitRecord.parse(p);
    const first = permits.find((p) => p.capId.capID3 === "00U4X")!;
    expect(first).toMatchObject({
      permitNumber: "A26-00U4X",
      status: "Issued",
      openedDate: "2026-09-04", // from the search row
      address: "1500 JERSTAD, KISSIMMEE FL 34746", // from the search row
      jobValue: 22599,
      parcelNumber: "252628610005220080",
      rawHtmlPath: path.join("raw", "A26-006408.html"), // archive is keyed by the list record number
    });
    expect(existsSync(path.join(outDir, first.rawHtmlPath))).toBe(true);
    expect(first.rawHtmlSha256).toMatch(/^[0-9a-f]{64}$/);

    const listOnly = readJsonl<{ permitNumber: string }>(path.join(outDir, "list-only.jsonl"));
    expect(listOnly.map((r) => r.permitNumber)).toEqual(["OSCTEMP26-35056", "OSCTEMP26-35046", "OSCTEMP26-35042", "OSCTEMP26-35056", "OSCTEMP26-35046", "OSCTEMP26-35042"]);
    expect(readJsonl(path.join(outDir, "failures.jsonl"))).toEqual([]);
    expect(readJsonl<{ permitNumber: string; extra: Record<string, string> }>(path.join(outDir, "details-extra.jsonl"))[0]!.extra["Reroof"]).toBe("Yes");
    expect(JSON.parse(readFileSync(path.join(outDir, "summary.json"), "utf8"))).toMatchObject({ listOnlyRows: 6, pagesFetched: 2 });
  });

  it("records permanent failures, retries transient ones, never throws", async () => {
    const outDir = tmp();
    let flaky = 0;
    const portal = fakePortal({
      intercept: (url) => {
        if (url.includes("capID3=00U45")) return new Response("gone", { status: 404 });
        if (url.includes("capID3=00U3Y") && flaky++ < 2) return new Response("oops", { status: 503 });
        if (url.includes("capID3=00U3E")) return new Response("<html>session expired</html>", { status: 200 });
        if (url.includes("capID3=00U31")) return new Response("down", { status: 500 });
        return undefined;
      },
    });
    const summary = await harvestWindow({ ...base, outDir, fetchImpl: portal.fetchImpl, concurrency: 3 });
    expect(summary.detailsFailed).toBe(3);
    expect(summary.detailsFetched).toBe(11);
    const failures = readJsonl<{ permitNumber: string; attempt: number; kind: string; error: string }>(path.join(outDir, "failures.jsonl"));
    expect(failures.map((f) => [f.permitNumber, f.kind, f.attempt]).sort()).toEqual([
      ["A26-006405", "permanent", 1], // 404 (00U45)
      ["A26-006396", "permanent", 1], // parse failure (00U3E)
      ["A26-006394", "transient", 4], // 500 four times (00U31)
    ].sort());
    expect(flaky).toBe(3); // two 503s then success for 00U3Y
    expect(portal.calls.filter((c) => c.includes("capID3=00U31"))).toHaveLength(4);
  });

  it("skips unchanged archived details on a second run", async () => {
    const outDir = tmp();
    const portal = fakePortal();
    await harvestWindow({ ...base, outDir, fetchImpl: portal.fetchImpl });
    const firstDetailCalls = portal.calls.filter((c) => c.includes("CapDetail")).length;
    expect(firstDetailCalls).toBe(14);

    const again = await harvestWindow({ ...base, outDir, fetchImpl: portal.fetchImpl });
    expect(portal.calls.filter((c) => c.includes("CapDetail")).length).toBe(14); // no new detail requests
    expect(again.detailsFetched).toBe(14);
    expect(again.requestCount).toBe(3);
    expect(JSON.parse(readFileSync(path.join(outDir, "summary.json"), "utf8"))).toMatchObject({ detailsSkippedUnchanged: 14 });
    expect(readJsonl(path.join(outDir, "permits.jsonl"))).toHaveLength(14);

    const third = await harvestWindow({ ...base, outDir, fetchImpl: portal.fetchImpl, skipExisting: false });
    expect(third.requestCount).toBe(17);
  });

  it("fails loudly when a pager postback comes back without the grid", async () => {
    const portal = fakePortal({
      intercept: (url, init) => {
        const body = typeof init.body === "string" ? init.body : "";
        return url.includes("CapHome.aspx") && body.includes("ctl13%24ctl03") ? new Response("1|#||4|10|updatePanel|ctl00_PlaceHolderMain_updatePanel|<div>form</div>|", { status: 200 }) : undefined;
      },
    });
    await expect(harvestWindow({ ...base, outDir: tmp(), fetchImpl: portal.fetchImpl })).rejects.toThrow(/returned no result grid/);
  });

  it("rejects malformed windows", async () => {
    await expect(harvestWindow({ ...base, since: "2026-09-08", outDir: tmp(), fetchImpl: fakePortal().fetchImpl })).rejects.toThrow(/after/);
    await expect(harvestWindow({ ...base, since: "09/01/2026", outDir: tmp(), fetchImpl: fakePortal().fetchImpl })).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe("harvestRange", () => {
  it("bisects date windows", () => {
    expect(bisectWindow("2026-09-01", "2026-09-07")).toEqual([
      { since: "2026-09-01", until: "2026-09-04" },
      { since: "2026-09-05", until: "2026-09-07" },
    ]);
    expect(bisectWindow("2026-09-01", "2026-09-02")).toEqual([
      { since: "2026-09-01", until: "2026-09-01" },
      { since: "2026-09-02", until: "2026-09-02" },
    ]);
    expect(() => bisectWindow("2026-09-01", "2026-09-01")).toThrow();
  });

  it("splits capped windows until every terminal window is uncapped and merges the output", async () => {
    const outDir = tmp();
    const portal = fakePortal({ bisect: true });
    const summaries = await harvestRange({ ...base, since: "2026-09-01", until: "2026-09-03", outDir, fetchImpl: portal.fetchImpl });

    expect(summaries.map((s) => [s.window.since, s.window.until, s.capped])).toEqual([
      ["2026-09-01", "2026-09-01", false],
      ["2026-09-02", "2026-09-02", false],
      ["2026-09-03", "2026-09-03", false],
    ]);
    // Capped probes (09-01..09-03, 09-01..09-02) stop after page 1 and fetch no details.
    const probeSearches = portal.calls.filter((c) => c.startsWith("POST")).length;
    expect(probeSearches).toBe(5); // 2 probes + 3 terminal single-page windows
    expect(portal.calls.filter((c) => c.includes("CapDetail")).length).toBe(7); // shared raw/ → each of the 7 records fetched once

    expect(existsSync(path.join(outDir, "windows", "2026-09-01_2026-09-03"))).toBe(false);
    expect(existsSync(path.join(outDir, "windows", "2026-09-01_2026-09-01", "summary.json"))).toBe(true);
    const merged = readJsonl<AccelaPermitRecord>(path.join(outDir, "permits.jsonl"));
    expect(merged).toHaveLength(7); // deduplicated by permit number across windows
    expect(merged[0]!.rawHtmlPath).toMatch(/^raw\/A26-\d+\.html$/); // rebased to outDir
    expect(existsSync(path.join(outDir, merged[0]!.rawHtmlPath))).toBe(true);
    const top = JSON.parse(readFileSync(path.join(outDir, "summary.json"), "utf8")) as Record<string, unknown>;
    expect(AccelaHarvestSummary.parse(top)).toMatchObject({ window: { since: "2026-09-01", until: "2026-09-03" }, capped: false, searchHits: 30, detailsFetched: 21 });
    expect(top["windows"]).toBe(3);
    expect(top["uniquePermits"]).toBe(7);
  });
});
