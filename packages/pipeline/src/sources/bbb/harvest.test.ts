import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BbbProfileRecord } from "@osceola/shared";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { BbbChallengeError, BbbHttpError, type BbbSession, type FetchedJson, type FetchedPage } from "./browser.js";
import { parseCategoryPage } from "./category.js";
import { harvestBbb } from "./harvest.js";

const fixtures = new URL("./__fixtures__/", import.meta.url);
const categoryHtml = readFileSync(new URL("category-kissimmee-roofing-p2.html", fixtures), "utf8");
const apiText = readFileSync(new URL("search-api-kissimmee-distance-p1.json", fixtures), "utf8");
const greenway = readFileSync(new URL("profile-greenway-roofing.html", fixtures), "utf8");
const cadwell = readFileSync(new URL("profile-affordable-roofing-cadwell.html", fixtures), "utf8");
const silent = pino({ level: "silent" });

/** Category page 1 fixture: the real page 2 relabelled as page 1 of 2. */
const categoryPage1 = categoryHtml.replace('"page":2,"pageSize":15,"totalPages":15', '"page":1,"pageSize":15,"totalPages":2');
/** Ids present in the page-1 fixture, used as targets for failure injection. */
const fixtureIds = parseCategoryPage(categoryHtml).results.map((r) => r.bbbId);
const [idA, idB] = fixtureIds as [string, string];
/** API page 2: the real Distance page 1 relabelled as the last of 2 pages. */
const apiPage2 = apiText.replace(/"page":\s*1,/, '"page": 2,').replace(/"totalPages":\s*15/, '"totalPages": 2');

interface FakeOptions {
  /** Return an override for a navigation (throw to simulate failures). */
  onGoto?: (url: string, calls: string[]) => FetchedPage | undefined;
  onFetch?: (url: string, calls: string[]) => FetchedJson | undefined;
}

function fakeSession(opts: FakeOptions = {}): { session: BbbSession; calls: string[] } {
  const calls: string[] = [];
  let requestCount = 0;
  const latencies: number[] = [];
  const page = (url: string, html: string, status = 200): FetchedPage => ({ url, finalUrl: url, status, html, title: "", latencyMs: 10, challenged: false });
  const session: BbbSession = {
    async gotoHtml(url) {
      calls.push(`GOTO ${url}`);
      requestCount++;
      latencies.push(10);
      const o = opts.onGoto?.(url, calls);
      if (o) return o;
      if (url.includes("/category/")) return page(url, url.includes("page=") ? categoryHtml : categoryPage1);
      if (url.includes("-0733-90573947")) return page(url, greenway);
      if (url.includes("-0733-22003102")) return page(url, cadwell);
      // every other profile: serve greenway's html — the id still comes from the URL
      return page(url, greenway);
    },
    async fetchJson(url) {
      calls.push(`API ${url}`);
      requestCount++;
      latencies.push(20);
      const o = opts.onFetch?.(url, calls);
      if (o) return o;
      const text = /page=2/.test(url) ? apiPage2 : apiText;
      return { url, status: 200, contentType: "application/json", text, json: JSON.parse(text) as unknown, latencyMs: 20 };
    },
    stats: () => ({ requestCount, challengeCount: 0, latenciesMs: [...latencies] }),
    close: async () => undefined,
  };
  return { session, calls };
}

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "bbb-harvest-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const readJsonl = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

describe("harvestBbb (fake session)", () => {
  it("walks page 1 (HTML) + API pages for every sort, dedupes by bbbId, writes validated records", async () => {
    const outDir = tmp();
    const { session, calls } = fakeSession();
    const summary = await harvestBbb({
      outDir,
      cities: ["kissimmee"],
      categories: ["roofing-contractors"],
      sorts: ["Relevance", "Distance"],
      pageDelayMs: 0,
      profileDelayMs: 0,
      logger: silent,
      sessionFactory: async () => session,
    });

    // Listing: 1 HTML nav + Relevance p2 + Distance p1,p2 = 3 API calls.
    expect(calls.filter((c) => c.startsWith("GOTO") && c.includes("/category/"))).toHaveLength(1);
    const api = calls.filter((c) => c.startsWith("API"));
    expect(api).toEqual([
      "API /api/search?find_country=USA&find_text=Roofing+Contractors&find_loc=Kissimmee%2C+FL&page=2",
      "API /api/search?find_country=USA&find_text=Roofing+Contractors&find_loc=Kissimmee%2C+FL&page=1&sort=Distance",
      "API /api/search?find_country=USA&find_text=Roofing+Contractors&find_loc=Kissimmee%2C+FL&page=2&sort=Distance",
    ]);
    expect(summary.pagesFetched).toBe(4);
    expect(summary.listingPagesViaHtml).toBe(1);
    expect(summary.listingPagesViaApi).toBe(3);
    expect(summary.categoryUrls).toEqual(["https://www.bbb.org/us/fl/kissimmee/category/roofing-contractors"]);

    // Profiles: every unique FL listing fetched exactly once.
    const records = readJsonl<BbbProfileRecord>(path.join(outDir, "profiles.jsonl"));
    expect(records.length).toBe(summary.profilesFetched);
    expect(summary.profilesFetched).toBe(summary.profilesListed - summary.profilesSkippedState);
    expect(records.length).toBeGreaterThan(15); // more than one page contributed
    expect(new Set(records.map((r) => r.bbbId)).size).toBe(records.length);
    for (const r of records) expect(() => BbbProfileRecord.parse(r)).not.toThrow();
    const rec = records.find((r) => r.bbbId === idA)!;
    expect(rec.licenseNumbers).toEqual(["CCC1331395"]); // every fake profile serves Greenway's HTML; the id comes from the URL
    expect(records.some((r) => r.ratingScore !== null)).toBe(true); // overlaid from the listing
    expect(rec.rawHtmlSha256).toHaveLength(64);
    expect(existsSync(path.join(outDir, "raw", "profiles", `${idA}.html`))).toBe(true);
    expect(existsSync(path.join(outDir, "raw", "listings", "kissimmee-roofing-contractors-Relevance-p1.html"))).toBe(true);
    expect(existsSync(path.join(outDir, "raw", "listings", "kissimmee-roofing-contractors-Distance-p2.json"))).toBe(true);

    const extras = readJsonl<{ bbbId: string; extra: { source: string } }>(path.join(outDir, "profiles-extra.jsonl"));
    expect(extras.length).toBe(records.length);
    const listings = readJsonl<{ sort: string; page: number }>(path.join(outDir, "listings.jsonl"));
    expect(listings.filter((l) => l.sort === "Distance" && l.page === 2).length).toBeGreaterThan(0);

    const written = JSON.parse(readFileSync(path.join(outDir, "summary.json"), "utf8")) as typeof summary;
    for (const k of ["categoryUrls", "pagesFetched", "profilesFetched", "profilesFailed", "startedAt", "finishedAt", "requestCount", "p50LatencyMs", "p95LatencyMs", "challengeCount"]) expect(written).toHaveProperty(k);
    expect(written.profilesFailed).toBe(0);
    expect(written.ratingDistribution["A+"]).toBe(records.length);
    expect(written.withLicense).toBe(records.length);
  });

  it("applies the state filter to the profile queue", async () => {
    const outDir = tmp();
    const { session, calls } = fakeSession();
    const summary = await harvestBbb({ outDir, cities: ["kissimmee"], sorts: ["Relevance"], maxPages: 1, states: ["TX"], pageDelayMs: 0, profileDelayMs: 0, logger: silent, sessionFactory: async () => session });
    expect(summary.profilesListed).toBe(15);
    expect(summary.profilesSkippedState).toBe(15);
    expect(summary.profilesFetched).toBe(0);
    expect(calls.some((c) => c.includes("/profile/"))).toBe(false);
  });

  it("resumes with skipExisting and honours maxProfiles", async () => {
    const outDir = tmp();
    const first = fakeSession();
    await harvestBbb({ outDir, cities: ["kissimmee"], sorts: ["Relevance"], maxPages: 1, maxProfiles: 2, pageDelayMs: 0, profileDelayMs: 0, logger: silent, sessionFactory: async () => first.session });
    expect(readJsonl(path.join(outDir, "profiles.jsonl"))).toHaveLength(2);

    const second = fakeSession();
    const summary = await harvestBbb({ outDir, cities: ["kissimmee"], sorts: ["Relevance"], maxPages: 1, pageDelayMs: 0, profileDelayMs: 0, logger: silent, sessionFactory: async () => second.session });
    expect(summary.profilesSkippedExisting).toBe(2);
    const profileNavs = second.calls.filter((c) => c.startsWith("GOTO") && c.includes("/profile/"));
    expect(profileNavs.length).toBe(summary.profilesFetched);
    const firstRunIds = first.calls.filter((c) => c.startsWith("GOTO") && c.includes("/profile/")).map((c) => /-(\d{3,4}-\d+)/.exec(c)![1]!);
    expect(firstRunIds).toHaveLength(2);
    for (const id of firstRunIds) expect(profileNavs.some((c) => c.includes(`-${id}`))).toBe(false); // not re-fetched
    const all = readJsonl<BbbProfileRecord>(path.join(outDir, "profiles.jsonl"));
    expect(new Set(all.map((r) => r.bbbId)).size).toBe(all.length);
  });

  it("records permanent profile failures, retries transient ones, and falls back to HTML for Relevance pages", async () => {
    const outDir = tmp();
    let transientLeft = 1;
    const { session, calls } = fakeSession({
      onGoto: (url) => {
        if (url.includes(`-${idA}`)) throw new BbbHttpError(url, 404);
        if (url.includes(`-${idB}`) && transientLeft-- > 0) throw new BbbChallengeError(url, 3);
        return undefined;
      },
      onFetch: (url) => (/page=2$/.test(url) ? { url, status: 403, contentType: "text/html", text: "<title>Just a moment...</title>", json: null, latencyMs: 5 } : undefined),
    });
    const summary = await harvestBbb({ outDir, cities: ["kissimmee"], sorts: ["Relevance"], maxPages: 2, pageDelayMs: 0, profileDelayMs: 0, maxAttempts: 2, logger: silent, sessionFactory: async () => session });

    // API page 2 failed twice → HTML fallback navigation for ?page=2.
    expect(calls.filter((c) => c === "API /api/search?find_country=USA&find_text=Roofing+Contractors&find_loc=Kissimmee%2C+FL&page=2")).toHaveLength(2);
    expect(calls).toContain("GOTO https://www.bbb.org/us/fl/kissimmee/category/roofing-contractors?page=2");
    expect(summary.listingPagesViaHtml).toBe(2);
    expect(summary.pagesFetched).toBe(2);

    const failures = readJsonl<{ kind: string; bbbId: string; permanent: boolean; status: number | null }>(path.join(outDir, "failures.jsonl"));
    const permanentFail = failures.find((f) => f.bbbId === idA)!;
    expect(permanentFail).toMatchObject({ kind: "profile", permanent: true, status: 404 });
    expect(calls.filter((c) => c.includes(`-${idA}`)).length).toBe(1); // permanent → no retry
    expect(failures.some((f) => f.bbbId === idB)).toBe(false); // transient, retried, succeeded
    expect(calls.filter((c) => c.includes(`-${idB}`)).length).toBe(2);
    expect(summary.profilesFailed).toBe(1);
    const records = readJsonl<BbbProfileRecord>(path.join(outDir, "profiles.jsonl"));
    expect(records.some((r) => r.bbbId === idB)).toBe(true);
    expect(records.some((r) => r.bbbId === idA)).toBe(false);
  });

  it("reuses listings.jsonl from a previous run and skips the listing walk", async () => {
    const outDir = tmp();
    const first = fakeSession();
    await harvestBbb({ outDir, cities: ["kissimmee"], sorts: ["Relevance"], maxPages: 1, maxProfiles: 1, pageDelayMs: 0, profileDelayMs: 0, logger: silent, sessionFactory: async () => first.session });

    const second = fakeSession();
    const summary = await harvestBbb({ outDir, cities: ["kissimmee"], reuseListings: true, pageDelayMs: 0, profileDelayMs: 0, logger: silent, sessionFactory: async () => second.session });
    expect(second.calls.filter((c) => c.startsWith("API"))).toHaveLength(0);
    expect(second.calls.filter((c) => c.includes("/category/"))).toHaveLength(1); // one navigation to put the page on bbb.org
    expect(summary.profilesListed).toBe(15);
    expect(summary.profilesSkippedExisting).toBe(1);
    expect(summary.profilesFetched).toBe(14);
    expect(summary.pagesFetched).toBe(0);
    expect(readJsonl<{ ratingScore: number | null }>(path.join(outDir, "profiles.jsonl")).some((r) => r.ratingScore !== null)).toBe(true); // listing fields survived the round trip
  });

  it("throws when every category page is blocked", async () => {
    const outDir = tmp();
    const { session } = fakeSession({
      onGoto: (url) => {
        throw new BbbChallengeError(url, 1);
      },
    });
    await expect(harvestBbb({ outDir, cities: ["orlando"], pageDelayMs: 0, profileDelayMs: 0, maxAttempts: 1, logger: silent, sessionFactory: async () => session })).rejects.toThrow(/blocked/);
    const failures = readJsonl<{ kind: string }>(path.join(outDir, "failures.jsonl"));
    expect(failures).toHaveLength(1);
    expect(failures[0]!.kind).toBe("listing");
  });
});
