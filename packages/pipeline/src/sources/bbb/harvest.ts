/**
 * BBB harvest orchestration.
 *
 * ```
 * for each city × category:
 *   navigate  /us/fl/<city>/category/<category>            (page 1, establishes cookies)
 *   for each sort: fetch /api/search?…&page=N&sort=<sort>   (same-origin, inside the page)
 *     – falls back to navigating ?page=N when the API answers with a challenge/error
 * dedupe listings by bbbId → navigate every profile once → parse, validate, write
 * ```
 *
 * Output directory layout:
 * ```
 * profiles.jsonl         BbbProfileRecord per line (validated against @osceola/shared)
 * profiles-extra.jsonl   { bbbId, extra } — fields the contract does not model
 * listings.jsonl         every ListingResult seen with { city, category, sort, page } provenance
 * failures.jsonl         { kind, bbbId?, url, status?, message, permanent, at }
 * summary.json           BbbHarvestSummaryShape
 * raw/listings/<city>-<category>-<sort>-p<N>.(html|json)
 * raw/profiles/<bbbId>.html
 * ```
 * Everything is append-only and keyed by `bbbId`, so a re-run with
 * `skipExisting` resumes where the previous one stopped.
 *
 * @module sources/bbb/harvest
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BbbProfileRecord } from "@osceola/shared";
import pino, { type Logger } from "pino";
import { BbbChallengeError, BbbHttpError, jitter, openBbbSession, percentile, sleep, type BbbSession, type BbbSessionOptions } from "./browser.js";
import { buildCategoryUrl, buildSearchApiPath, parseCategoryPage, parseSearchResult, type CategoryListing, type ListingResult } from "./category.js";
import { slugToTitle } from "./normalize.js";
import { ProfileParseError, parseProfilePage } from "./profile.js";

/** Osceola County service area: the county's cities plus Orlando, where most contractors serving it are based. */
export const DEFAULT_CITIES = ["kissimmee", "saint-cloud", "celebration", "poinciana", "orlando"] as const;
export const DEFAULT_CATEGORIES = ["roofing-contractors"] as const;
/** Sort orders that each expose a different 225-result window of the listing pool. */
export const DEFAULT_SORTS = ["Relevance", "Distance", "AToZ", "ZToA"] as const;
/** BBB's hard cap on listing pages per query (page 16 → HTTP 500). */
export const BBB_PAGE_CAP = 15;

export interface BbbHarvestOptions {
  outDir: string;
  /** URL city slugs, default {@link DEFAULT_CITIES}. */
  cities?: string[];
  /** URL category slugs, default {@link DEFAULT_CATEGORIES}. */
  categories?: string[];
  /** Sort orders to walk per city × category, default {@link DEFAULT_SORTS}. */
  sorts?: string[];
  /** Keep only listings in these states (two-letter), default `["FL"]`; empty array = keep all. */
  states?: string[];
  /** Listing pages per (city, category, sort); default and maximum {@link BBB_PAGE_CAP}. */
  maxPages?: number;
  /** Stop after this many profile fetches (existing + new). */
  maxProfiles?: number;
  /** Delay between listing requests (ms), default 2 500 (jittered ±20 %). */
  pageDelayMs?: number;
  /** Delay between profile navigations (ms), default 2 500 (jittered ±20 %). */
  profileDelayMs?: number;
  /** Default `true`. */
  headless?: boolean;
  /** Playwright channel; default `"chrome"` with fallback to bundled Chromium, `null` forces bundled. */
  channel?: string | null;
  /** Skip profiles already present in `profiles.jsonl` (resume). Default `true`. */
  skipExisting?: boolean;
  /**
   * Reuse `listings.jsonl` from a previous run in `outDir` instead of walking
   * the listings again (skips ~300 requests when resuming the profile phase).
   * Default `false`; ignored when the file is missing.
   */
  reuseListings?: boolean;
  /** Attempts per profile / listing request on transient failures. Default 3. */
  maxAttempts?: number;
  challengeAttempts?: number;
  challengeCheckIntervalMs?: number;
  logger?: Logger;
  /** Test seam: supply a fake session instead of launching a browser. */
  sessionFactory?: (opts: BbbSessionOptions) => Promise<BbbSession>;
}

/** `summary.json` contents. */
export interface BbbHarvestSummaryShape {
  categoryUrls: string[];
  pagesFetched: number;
  profilesFetched: number;
  profilesFailed: number;
  startedAt: string;
  finishedAt: string;
  requestCount: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  challengeCount: number;
  /** Extras (not part of the kit contract, useful for reconciliation). */
  profilesListed: number;
  profilesSkippedExisting: number;
  profilesSkippedState: number;
  listingPagesViaApi: number;
  listingPagesViaHtml: number;
  listingFailures: number;
  ratingDistribution: Record<string, number>;
  withLicense: number;
  withPhone: number;
  outDir: string;
}

/** One line of `failures.jsonl`. */
export interface BbbHarvestFailure {
  kind: "listing" | "profile";
  bbbId: string | null;
  url: string;
  status: number | null;
  message: string;
  /** True for 404 / parse errors; false when retries of a transient error were exhausted. */
  permanent: boolean;
  at: string;
}

interface ListingProvenance {
  city: string;
  category: string;
  sort: string;
  page: number;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const jsonl = (o: unknown): string => `${JSON.stringify(o)}\n`;
const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_");

async function readExistingIds(file: string): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!existsSync(file)) return ids;
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const id = (JSON.parse(line) as { bbbId?: unknown }).bbbId;
      if (typeof id === "string") ids.add(id);
    } catch {
      /* skip corrupt line */
    }
  }
  return ids;
}

/** Rebuild the bbbId → first listing map from `listings.jsonl` (provenance fields ignored). */
async function readListings(file: string): Promise<Map<string, ListingResult>> {
  const out = new Map<string, ListingResult>();
  if (!existsSync(file)) return out;
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      for (const k of ["searchCity", "searchCategory", "category", "sort", "page"]) delete row[k];
      if (typeof row.bbbId === "string" && typeof row.profileUrl === "string" && typeof row.name === "string" && !out.has(row.bbbId)) {
        out.set(row.bbbId, {
          phones: [],
          categories: [],
          city: null,
          state: null,
          postalCode: null,
          rating: null,
          ratingScore: null,
          accredited: null,
          primaryCategory: null,
          outOfBusiness: false,
          bureauId: row.bbbId.split("-")[0] ?? "",
          businessId: row.bbbId.split("-")[1] ?? "",
          ...(row as unknown as Partial<ListingResult>),
        } as ListingResult);
      }
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

function classify(err: unknown): { permanent: boolean; status: number | null; message: string } {
  if (err instanceof BbbHttpError) return { permanent: err.permanent, status: err.status, message: err.message };
  if (err instanceof BbbChallengeError) return { permanent: false, status: 403, message: err.message };
  if (err instanceof ProfileParseError) return { permanent: true, status: null, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  // Playwright navigation timeouts / net errors are transient.
  return { permanent: false, status: null, message };
}

/**
 * Run the harvest. Never throws for a single bad page — listing and profile
 * failures are recorded in `failures.jsonl`; the browser failing to launch or
 * every category page being blocked does throw.
 */
export async function harvestBbb(opts: BbbHarvestOptions): Promise<BbbHarvestSummaryShape> {
  const log = opts.logger ?? pino({ level: process.env.LOG_LEVEL ?? "info" });
  const cities = opts.cities ?? [...DEFAULT_CITIES];
  const categories = opts.categories ?? [...DEFAULT_CATEGORIES];
  const sorts = opts.sorts && opts.sorts.length > 0 ? opts.sorts : [...DEFAULT_SORTS];
  const states = new Set((opts.states ?? ["FL"]).map((s) => s.toUpperCase()));
  const maxPages = Math.min(BBB_PAGE_CAP, Math.max(1, opts.maxPages ?? BBB_PAGE_CAP));
  const pageDelayMs = opts.pageDelayMs ?? 2_500;
  const profileDelayMs = opts.profileDelayMs ?? 2_500;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const skipExisting = opts.skipExisting ?? true;

  const outDir = opts.outDir;
  const rawListings = path.join(outDir, "raw", "listings");
  const rawProfiles = path.join(outDir, "raw", "profiles");
  await mkdir(rawListings, { recursive: true });
  await mkdir(rawProfiles, { recursive: true });
  const profilesFile = path.join(outDir, "profiles.jsonl");
  const extraFile = path.join(outDir, "profiles-extra.jsonl");
  const listingsFile = path.join(outDir, "listings.jsonl");
  const failuresFile = path.join(outDir, "failures.jsonl");
  const summaryFile = path.join(outDir, "summary.json");

  const startedAt = new Date().toISOString();
  const existing = skipExisting ? await readExistingIds(profilesFile) : new Set<string>();
  const failures: BbbHarvestFailure[] = [];
  const recordFailure = async (f: Omit<BbbHarvestFailure, "at">): Promise<void> => {
    const full = { ...f, at: new Date().toISOString() };
    failures.push(full);
    await appendFile(failuresFile, jsonl(full));
    log.warn(full, "bbb failure");
  };

  const sessionOpts: BbbSessionOptions = { headless: opts.headless ?? true, logger: log };
  if (opts.channel !== undefined) sessionOpts.channel = opts.channel;
  if (opts.challengeAttempts !== undefined) sessionOpts.challengeAttempts = opts.challengeAttempts;
  if (opts.challengeCheckIntervalMs !== undefined) sessionOpts.challengeCheckIntervalMs = opts.challengeCheckIntervalMs;
  const session = await (opts.sessionFactory ?? openBbbSession)(sessionOpts);

  const categoryUrls: string[] = [];
  const listed = new Map<string, ListingResult>(); // bbbId → first listing seen
  let pagesFetched = 0;
  let listingPagesViaApi = 0;
  let listingPagesViaHtml = 0;
  let profilesFetched = 0;
  let profilesSkippedExisting = 0;
  let profilesSkippedState = 0;
  const ratingDistribution: Record<string, number> = {};
  let withLicense = 0;
  let withPhone = 0;

  const buildSummary = (): BbbHarvestSummaryShape => {
    const s = session.stats();
    return {
      categoryUrls,
      pagesFetched,
      profilesFetched,
      profilesFailed: failures.filter((f) => f.kind === "profile").length,
      startedAt,
      finishedAt: new Date().toISOString(),
      requestCount: s.requestCount,
      p50LatencyMs: percentile(s.latenciesMs, 50),
      p95LatencyMs: percentile(s.latenciesMs, 95),
      challengeCount: s.challengeCount,
      profilesListed: listed.size,
      profilesSkippedExisting,
      profilesSkippedState,
      listingPagesViaApi,
      listingPagesViaHtml,
      listingFailures: failures.filter((f) => f.kind === "listing").length,
      ratingDistribution,
      withLicense,
      withPhone,
      outDir,
    };
  };
  const flushSummary = async (): Promise<void> => writeFile(summaryFile, `${JSON.stringify(buildSummary(), null, 2)}\n`, "utf8");

  const absorb = async (listing: CategoryListing, prov: ListingProvenance): Promise<number> => {
    let fresh = 0;
    for (const r of listing.results) {
      await appendFile(listingsFile, jsonl({ searchCity: prov.city, searchCategory: prov.category, sort: prov.sort, page: prov.page, ...r }));
      if (!listed.has(r.bbbId)) {
        listed.set(r.bbbId, r);
        fresh++;
      }
    }
    return fresh;
  };

  /** Navigate to a listing page with retries; returns null after recording a failure. */
  const gotoListing = async (url: string): Promise<string | null> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return (await session.gotoHtml(url)).html;
      } catch (err) {
        const c = classify(err);
        log.warn({ url, attempt, ...c }, "listing navigation failed");
        if (c.permanent || attempt === maxAttempts) {
          await recordFailure({ kind: "listing", bbbId: null, url, status: c.status, message: c.message, permanent: c.permanent });
          return null;
        }
        await sleep(jitter(pageDelayMs * 2 * attempt));
      }
    }
    return null;
  };

  try {
    // ---------------------------------------------------------------- listings
    const reused = opts.reuseListings ? await readListings(listingsFile) : null;
    if (reused && reused.size > 0) {
      for (const [id, r] of reused) listed.set(id, r);
      for (const city of cities) for (const category of categories) categoryUrls.push(buildCategoryUrl(city, category));
      log.info({ listed: listed.size, file: listingsFile }, "reusing listings from previous run");
      // The page context still has to be on bbb.org before profiles are fetched; one navigation does it.
      await gotoListing(categoryUrls[0] ?? buildCategoryUrl(cities[0] ?? "kissimmee", categories[0] ?? "roofing-contractors"));
    }
    for (const city of reused && reused.size > 0 ? [] : cities) {
      for (const category of categories) {
        const categoryUrl = buildCategoryUrl(city, category);
        categoryUrls.push(categoryUrl);
        const html = await gotoListing(categoryUrl);
        if (html === null) continue;
        pagesFetched++;
        listingPagesViaHtml++;
        await writeFile(path.join(rawListings, `${safe(city)}-${safe(category)}-Relevance-p1.html`), html, "utf8");
        const first = parseCategoryPage(html);
        const fresh = await absorb(first, { city, category, sort: "Relevance", page: 1 });
        const totalPages = Math.min(maxPages, first.totalPages ?? (first.hasNext ? maxPages : 1));
        const text = first.searchText ?? slugToTitle(category);
        const location = first.searchLocation ?? `${slugToTitle(city)}, FL`;
        log.info({ city, category, totalResults: first.totalResults, totalPages: first.totalPages, walking: totalPages, results: first.results.length, fresh }, "category page 1");

        for (const sort of sorts) {
          const startPage = sort === "Relevance" ? 2 : 1;
          for (let page = startPage; page <= totalPages; page++) {
            await sleep(jitter(pageDelayMs));
            const prov = { city, category, sort, page };
            const stem = `${safe(city)}-${safe(category)}-${safe(sort)}-p${page}`;
            const apiPath = buildSearchApiPath({ text, location, page, sort });
            let listing: CategoryListing | null = null;
            let lastStatus: number | null = null;
            for (let attempt = 1; attempt <= maxAttempts && listing === null; attempt++) {
              try {
                const res = await session.fetchJson(apiPath);
                lastStatus = res.status;
                if (res.status === 200 && res.json !== null) {
                  await writeFile(path.join(rawListings, `${stem}.json`), res.text, "utf8");
                  listing = parseSearchResult(res.json);
                  listingPagesViaApi++;
                } else {
                  log.warn({ apiPath, status: res.status, attempt, contentType: res.contentType }, "search api non-200; re-establishing page context");
                  // A challenge or expired clearance: navigating a real page refreshes the cookies.
                  await sleep(jitter(pageDelayMs));
                  await gotoListing(categoryUrl);
                }
              } catch (err) {
                log.warn({ apiPath, attempt, err: err instanceof Error ? err.message : String(err) }, "search api call threw");
                await sleep(jitter(pageDelayMs * attempt));
              }
            }
            if (listing === null && sort === "Relevance") {
              // HTML fallback exists only for the default sort (the page URL has no sort parameter).
              const pageUrl = buildCategoryUrl(city, category, page);
              const pageHtml = await gotoListing(pageUrl);
              if (pageHtml !== null) {
                await writeFile(path.join(rawListings, `${stem}.html`), pageHtml, "utf8");
                listing = parseCategoryPage(pageHtml);
                listingPagesViaHtml++;
              }
            }
            if (listing === null) {
              await recordFailure({ kind: "listing", bbbId: null, url: apiPath, status: lastStatus, message: "listing page unavailable via api" + (sort === "Relevance" ? " and html" : ""), permanent: false });
              break; // later pages of this sort are unlikely to fare better
            }
            pagesFetched++;
            const added = await absorb(listing, prov);
            log.info({ city, category, sort, page, results: listing.results.length, fresh: added, listed: listed.size }, "listing page");
            if (listing.results.length === 0 || !listing.hasNext) break;
          }
        }
        await flushSummary();
      }
    }
    if (!(reused && reused.size > 0) && categoryUrls.length > 0 && pagesFetched === 0) {
      throw new Error(`every category page was blocked or failed (${failures.length} failures); see ${failuresFile}`);
    }

    // ---------------------------------------------------------------- profiles
    const queue = [...listed.values()].filter((r) => {
      if (states.size === 0 || (r.state && states.has(r.state.toUpperCase()))) return true;
      profilesSkippedState++;
      return false;
    });
    log.info({ listed: listed.size, queued: queue.length, skippedState: profilesSkippedState, existing: existing.size }, "profile phase");
    let processed = 0;
    for (const item of queue) {
      if (opts.maxProfiles !== undefined && processed >= opts.maxProfiles) break;
      processed++;
      if (existing.has(item.bbbId)) {
        profilesSkippedExisting++;
        continue;
      }
      await sleep(jitter(profileDelayMs));
      let done = false;
      for (let attempt = 1; attempt <= maxAttempts && !done; attempt++) {
        try {
          const fetched = await session.gotoHtml(item.profileUrl);
          await writeFile(path.join(rawProfiles, `${safe(item.bbbId)}.html`), fetched.html, "utf8");
          const parsed = parseProfilePage(fetched.html, item.profileUrl);
          const { extra, ...fields } = parsed;
          const record = BbbProfileRecord.parse({
            ...fields,
            ratingScore: fields.ratingScore ?? item.ratingScore,
            fetchedAt: new Date().toISOString(),
            rawHtmlSha256: sha256(fetched.html),
          });
          await appendFile(profilesFile, jsonl(record));
          await appendFile(extraFile, jsonl({ bbbId: record.bbbId, listing: { city: item.city, state: item.state, postalCode: item.postalCode, primaryCategory: item.primaryCategory, ratingScore: item.ratingScore }, extra }));
          existing.add(record.bbbId);
          profilesFetched++;
          ratingDistribution[record.rating ?? "NR"] = (ratingDistribution[record.rating ?? "NR"] ?? 0) + 1;
          if (record.licenseNumbers.length > 0) withLicense++;
          if (record.phone) withPhone++;
          done = true;
          log.info({ bbbId: record.bbbId, name: record.name, rating: record.rating, licenses: record.licenseNumbers.length, ms: fetched.latencyMs, challenged: fetched.challenged, n: profilesFetched, of: queue.length }, "profile");
        } catch (err) {
          const c = classify(err);
          log.warn({ bbbId: item.bbbId, url: item.profileUrl, attempt, ...c }, "profile failed");
          if (c.permanent || attempt === maxAttempts) {
            await recordFailure({ kind: "profile", bbbId: item.bbbId, url: item.profileUrl, status: c.status, message: c.message, permanent: c.permanent });
            break;
          }
          await sleep(jitter(profileDelayMs * 3 * attempt));
        }
      }
      if (profilesFetched % 25 === 0) await flushSummary();
    }
  } finally {
    await session.close();
  }
  await flushSummary();
  const summary = buildSummary();
  log.info({ ...summary, ratingDistribution: undefined, categoryUrls: undefined }, "bbb harvest finished");
  return summary;
}
