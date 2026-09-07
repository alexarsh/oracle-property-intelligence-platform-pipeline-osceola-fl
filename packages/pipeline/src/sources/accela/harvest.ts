/**
 * Harvest orchestration: run a windowed general search, fetch every linked
 * detail page with a small worker pool, archive raw HTML, validate and write
 * JSONL + summary, and bisect windows that hit the portal's 100-hit cap.
 *
 * Output layout of a window directory:
 * ```
 * permits.jsonl        AccelaPermitRecord per line (validated)
 * failures.jsonl       HarvestFailure per line
 * list-only.jsonl      SearchRow per line for rows WITHOUT a detail page (temporary applications)
 * search-rows.jsonl    every SearchRow seen (the permit list, for audit)
 * details-extra.jsonl  {permitNumber, extra} — unmapped "More Details" fields
 * summary.json         AccelaHarvestSummary (+ a few extra counters)
 * raw/<permitNumber>.html, raw/index.json (sha256 per archived page)
 * ```
 * `harvestRange` writes each terminal window under `windows/<since>_<until>/`,
 * shares one `raw/` for the whole range, and merges the JSONL files plus an
 * aggregate `summary.json` / `summaries.json` at the top level.
 *
 * @module sources/accela/harvest
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AccelaHarvestSummary, AccelaPermitRecord } from "@osceola/shared";
import pino, { type Logger } from "pino";
import {
  PermanentHttpError,
  TransientHttpError,
  createAccelaClient,
  percentile,
  sleep,
  type AccelaClient,
} from "./client.js";
import { DetailParseError, parseCapDetailExtended } from "./detail.js";
import { iterateSearchPages } from "./search.js";
import {
  DEFAULT_RECORD_TYPE,
  PORTAL_HIT_CAP,
  type AccelaHarvestOptions,
  type HarvestFailure,
  type SearchRow,
} from "./types.js";

/** Extra counters written into `summary.json` next to the contract fields. */
export interface HarvestWindowSummary extends AccelaHarvestSummary {
  /** Rows without a detail page (temporary applications) — listed in `list-only.jsonl`. */
  listOnlyRows: number;
  /** Detail pages served from the local archive because their sha256 was unchanged. */
  detailsSkippedUnchanged: number;
  /** Search result pages fetched. */
  pagesFetched: number;
  /** True when the window was abandoned after page 1 because it was capped and splittable. */
  stoppedEarly: boolean;
  /** Directory the files were written to. */
  outDir: string;
  /** Every request latency (ms) of this window, so ranges can compute exact percentiles. */
  latenciesMs: number[];
}

/** Internal knobs used by {@link harvestRange}; not part of the public options. */
interface InternalOptions {
  /** Shared raw archive directory (defaults to `<outDir>/raw`). */
  rawDir?: string;
  /** Return after the first page when it is capped so the caller can split. */
  stopWhenCapped?: boolean;
}

interface RawIndexEntry {
  sha256: string;
  fetchedAt: string;
  sourceUrl: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertWindow(since: string, until: string): void {
  if (!ISO_DATE.test(since) || !ISO_DATE.test(until)) throw new Error(`since/until must be YYYY-MM-DD, got ${since}..${until}`);
  if (since > until) throw new Error(`since (${since}) is after until (${until})`);
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const jsonl = (o: unknown): string => `${JSON.stringify(o)}\n`;

/** Windows-safe, collision-free file stem for a record number. */
function safeKeyPart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function readIndex(file: string): Promise<Record<string, RawIndexEntry>> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, RawIndexEntry>;
  } catch {
    return {};
  }
}

/** Run `fn` over `items` with at most `concurrency` in flight (FIFO, no starvation). */
async function runPool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Harvest one date window: search, page, fetch details, write artifacts.
 *
 * Detail failures never throw: permanent ones (404, parse error) and
 * transient ones that exhausted their retries land in `failures.jsonl`. A
 * search failure (after retries) does throw — without the list there is
 * nothing to harvest.
 */
export async function harvestWindow(opts: AccelaHarvestOptions): Promise<AccelaHarvestSummary> {
  return harvestWindowInternal(opts, {});
}

async function harvestWindowInternal(opts: AccelaHarvestOptions, internal: InternalOptions): Promise<HarvestWindowSummary> {
  assertWindow(opts.since, opts.until);
  const recordType = opts.recordType ?? DEFAULT_RECORD_TYPE;
  const concurrency = opts.concurrency ?? 2;
  const minDelayMs = opts.minDelayMs ?? 400;
  const skipExisting = opts.skipExisting ?? true;
  const logger: Logger = opts.logger ?? pino({ level: "silent" });
  const startedAt = new Date().toISOString();

  const outDir = path.resolve(opts.outDir);
  const rawDir = path.resolve(internal.rawDir ?? path.join(outDir, "raw"));
  await mkdir(outDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
  const files = {
    permits: path.join(outDir, "permits.jsonl"),
    failures: path.join(outDir, "failures.jsonl"),
    listOnly: path.join(outDir, "list-only.jsonl"),
    rows: path.join(outDir, "search-rows.jsonl"),
    extra: path.join(outDir, "details-extra.jsonl"),
    summary: path.join(outDir, "summary.json"),
    index: path.join(rawDir, "index.json"),
  };
  // A window directory is rewritten from scratch on every run; only raw/ persists.
  await Promise.all([files.permits, files.failures, files.listOnly, files.rows, files.extra].map((f) => writeFile(f, "")));

  const client: AccelaClient = createAccelaClient({
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.retryBaseDelayMs !== undefined ? { retryBaseDelayMs: opts.retryBaseDelayMs } : {}),
    logger,
  });

  // ---- 1. search + paginate -------------------------------------------------------------
  const rows: SearchRow[] = [];
  let total: number | null = null;
  let capped = false;
  let pagesFetched = 0;
  let stoppedEarly = false;
  const pages = iterateSearchPages(client, { recordType, since: opts.since, until: opts.until }, {
    ...(internal.stopWhenCapped ? { stopWhenCapped: true } : {}),
    minDelayMs,
  });
  for await (const page of pages) {
    pagesFetched++;
    rows.push(...page.rows);
    total = page.total ?? total;
    capped ||= page.capped;
    logger.info(
      { window: `${opts.since}..${opts.until}`, page: page.currentPage, rows: page.rows.length, total: page.total, capped: page.capped },
      "accela search page",
    );
    if (internal.stopWhenCapped && page.capped && page.hasNextPage) {
      stoppedEarly = true;
      break;
    }
  }
  // A total the portal did not print is treated as at-cap once we have seen a full cap of rows.
  if (total === null && rows.length >= PORTAL_HIT_CAP) capped = true;
  for (const row of rows) await appendFile(files.rows, jsonl(row));

  // ---- 2. details ------------------------------------------------------------------------
  const index = await readIndex(files.index);
  const seen = new Set<string>();
  const linked: SearchRow[] = [];
  let listOnly = 0;
  for (const row of rows) {
    if (!row.detailUrl || !row.capId) {
      listOnly++;
      await appendFile(files.listOnly, jsonl(row));
      continue;
    }
    if (seen.has(row.permitNumber)) continue; // the same record can be listed twice when its date is updated mid-run
    seen.add(row.permitNumber);
    linked.push(row);
  }

  let detailsFetched = 0;
  let detailsFailed = 0;
  let detailsSkipped = 0;
  const failures: HarvestFailure[] = [];

  const emit = async (row: SearchRow, html: string, fetchedAt: string, rawHtmlPath: string): Promise<void> => {
    const { record: detail, extra } = parseCapDetailExtended(html, row.detailUrl!);
    if (detail.permitNumber !== row.permitNumber) {
      // The list and the page disagree — keep the page's number but leave an audit trail.
      extra["list.permitNumber"] = row.permitNumber;
    }
    const record = AccelaPermitRecord.parse({
      ...detail,
      // Fields the detail page does not show come from the search row (documented in README).
      recordType: detail.recordType ?? row.recordType,
      status: detail.status ?? row.status,
      openedDate: detail.openedDate ?? row.date,
      expirationDate: detail.expirationDate ?? row.expirationDate,
      description: detail.description ?? row.description,
      address: detail.address ?? row.address,
      fetchedAt,
      rawHtmlSha256: sha256(html),
      rawHtmlPath,
    });
    await appendFile(files.permits, jsonl(record));
    if (Object.keys(extra).length > 0) {
      await appendFile(files.extra, jsonl({ permitNumber: record.permitNumber, extra, listRow: { projectName: row.projectName, shortNote: row.shortNote, recordId: row.recordId } }));
    }
  };

  await runPool(linked, concurrency, async (row) => {
    const url = row.detailUrl!;
    const fileName = `${safeKeyPart(row.permitNumber)}.html`;
    const rawPath = path.join(rawDir, fileName);
    const rawHtmlPath = path.relative(outDir, rawPath);
    const cached = index[row.permitNumber];

    if (skipExisting && cached && existsSync(rawPath)) {
      const html = await readFile(rawPath, "utf8");
      if (sha256(html) === cached.sha256) {
        try {
          await emit(row, html, cached.fetchedAt, rawHtmlPath);
          detailsSkipped++;
          detailsFetched++;
          return;
        } catch (err) {
          logger.warn({ permitNumber: row.permitNumber, err: String(err) }, "archived detail no longer parses; re-fetching");
        }
      }
    }

    let attempts = 0;
    try {
      const res = await client.get(url, { Referer: "https://permits.osceola.org/CitizenAccess/Cap/CapHome.aspx?module=Building&TabName=Building" });
      attempts = 1;
      const fetchedAt = new Date().toISOString();
      await writeFile(rawPath, res.body);
      await emit(row, res.body, fetchedAt, rawHtmlPath);
      index[row.permitNumber] = { sha256: sha256(res.body), fetchedAt, sourceUrl: url };
      detailsFetched++;
    } catch (err) {
      detailsFailed++;
      const failure: HarvestFailure = {
        permitNumber: row.permitNumber,
        url,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        attempt: err instanceof TransientHttpError || err instanceof PermanentHttpError ? err.attempts : attempts,
        kind: err instanceof TransientHttpError ? "transient" : "permanent",
      };
      if (!(err instanceof TransientHttpError || err instanceof PermanentHttpError || err instanceof DetailParseError)) {
        // Zod validation or an unexpected bug: still recorded, never thrown, but logged loudly.
        logger.error({ permitNumber: row.permitNumber, err: failure.error }, "unexpected detail failure");
      }
      failures.push(failure);
      await appendFile(files.failures, jsonl(failure));
      logger.warn({ permitNumber: row.permitNumber, kind: failure.kind, err: failure.error }, "accela detail failed");
    } finally {
      await sleep(minDelayMs);
    }
  });
  await writeFile(files.index, JSON.stringify(index, null, 2));

  // ---- 3. summary ------------------------------------------------------------------------
  const finishedAt = new Date().toISOString();
  const summary: HarvestWindowSummary = {
    ...AccelaHarvestSummary.parse({
      window: { since: opts.since, until: opts.until },
      recordType,
      searchHits: rows.length,
      capped,
      detailsFetched,
      detailsFailed,
      startedAt,
      finishedAt,
      requestCount: client.requestCount,
      p50LatencyMs: percentile(client.latenciesMs, 50),
      p95LatencyMs: percentile(client.latenciesMs, 95),
    }),
    listOnlyRows: listOnly,
    detailsSkippedUnchanged: detailsSkipped,
    pagesFetched,
    stoppedEarly,
    outDir,
    latenciesMs: [...client.latenciesMs],
  };
  await writeFile(files.summary, JSON.stringify(summary, null, 2));
  logger.info(
    { window: summary.window, searchHits: summary.searchHits, capped, detailsFetched, detailsFailed, listOnly, p50: summary.p50LatencyMs, p95: summary.p95LatencyMs },
    "accela window done",
  );
  return summary;
}

/** Split an inclusive ISO date range into two halves; requires `since < until`. */
export function bisectWindow(since: string, until: string): [{ since: string; until: string }, { since: string; until: string }] {
  const a = Date.parse(`${since}T00:00:00Z`);
  const b = Date.parse(`${until}T00:00:00Z`);
  const days = Math.round((b - a) / 86_400_000);
  if (days < 1) throw new Error(`cannot bisect a single-day window ${since}`);
  const midIso = new Date(a + Math.floor(days / 2) * 86_400_000).toISOString().slice(0, 10);
  const nextIso = new Date(a + (Math.floor(days / 2) + 1) * 86_400_000).toISOString().slice(0, 10);
  return [
    { since, until: midIso },
    { since: nextIso, until },
  ];
}

/**
 * Harvest a date range, recursively bisecting any window the portal caps at
 * 100 hits. A single-day window that is still capped cannot split further:
 * it is paginated to exhaustion and reported with `capped: true` so the
 * caller knows coverage for that day may be incomplete.
 *
 * Returns one summary per terminal window (in date order) and writes merged
 * artifacts at the top of `outDir` (see module docs for the layout).
 */
export async function harvestRange(opts: AccelaHarvestOptions): Promise<AccelaHarvestSummary[]> {
  assertWindow(opts.since, opts.until);
  const logger: Logger = opts.logger ?? pino({ level: "silent" });
  const outDir = path.resolve(opts.outDir);
  const rawDir = path.join(outDir, "raw");
  const windowsDir = path.join(outDir, "windows");
  await mkdir(windowsDir, { recursive: true });
  const summaries: HarvestWindowSummary[] = [];

  const recurse = async (since: string, until: string): Promise<void> => {
    const single = since === until;
    const dir = path.join(windowsDir, `${since}_${until}`);
    const summary = await harvestWindowInternal({ ...opts, since, until, outDir: dir, logger }, { rawDir, stopWhenCapped: !single });
    if (summary.capped && !single) {
      logger.info({ since, until, searchHits: summary.searchHits }, "window capped; bisecting");
      await rm(dir, { recursive: true, force: true }); // probe output is superseded by the halves
      const [left, right] = bisectWindow(since, until);
      await recurse(left.since, left.until);
      await recurse(right.since, right.until);
      return;
    }
    if (summary.capped) logger.warn({ since }, "single-day window is capped at 100 hits; coverage may be incomplete");
    summaries.push(summary);
  };
  await recurse(opts.since, opts.until);

  // ---- merge terminal windows ----------------------------------------------------------------
  const merged = { permits: new Map<string, string>(), failures: [] as string[], listOnly: [] as string[], rows: [] as string[], extra: [] as string[] };
  for (const s of summaries) {
    const read = async (name: string): Promise<string[]> =>
      (await readFile(path.join(s.outDir, name), "utf8").catch(() => "")).split("\n").filter((l) => l.length > 0);
    for (const line of await read("permits.jsonl")) {
      // Window files point at the shared archive relative to the window dir; the merged file must be relative to outDir.
      const rec = JSON.parse(line) as AccelaPermitRecord;
      rec.rawHtmlPath = path.relative(outDir, path.resolve(s.outDir, rec.rawHtmlPath));
      merged.permits.set(rec.permitNumber, JSON.stringify(rec));
    }
    merged.failures.push(...(await read("failures.jsonl")));
    merged.listOnly.push(...(await read("list-only.jsonl")));
    merged.rows.push(...(await read("search-rows.jsonl")));
    merged.extra.push(...(await read("details-extra.jsonl")));
  }
  const dump = (lines: Iterable<string>): string => [...lines].map((l) => `${l}\n`).join("");
  await writeFile(path.join(outDir, "permits.jsonl"), dump(merged.permits.values()));
  await writeFile(path.join(outDir, "failures.jsonl"), dump(merged.failures));
  await writeFile(path.join(outDir, "list-only.jsonl"), dump(merged.listOnly));
  await writeFile(path.join(outDir, "search-rows.jsonl"), dump(merged.rows));
  await writeFile(path.join(outDir, "details-extra.jsonl"), dump(merged.extra));

  const allLatencies = summaries.flatMap((s) => s.latenciesMs);
  const aggregate = AccelaHarvestSummary.parse({
    window: { since: opts.since, until: opts.until },
    recordType: opts.recordType ?? DEFAULT_RECORD_TYPE,
    searchHits: summaries.reduce((n, s) => n + s.searchHits, 0),
    capped: summaries.some((s) => s.capped),
    detailsFetched: summaries.reduce((n, s) => n + s.detailsFetched, 0),
    detailsFailed: summaries.reduce((n, s) => n + s.detailsFailed, 0),
    startedAt: summaries[0]?.startedAt ?? new Date().toISOString(),
    finishedAt: summaries.at(-1)?.finishedAt ?? new Date().toISOString(),
    requestCount: summaries.reduce((n, s) => n + s.requestCount, 0),
    p50LatencyMs: percentile(allLatencies, 50),
    p95LatencyMs: percentile(allLatencies, 95),
  });
  await writeFile(path.join(outDir, "summary.json"), JSON.stringify({ ...aggregate, windows: summaries.length, uniquePermits: merged.permits.size }, null, 2));
  await writeFile(path.join(outDir, "summaries.json"), JSON.stringify(summaries, null, 2));
  return summaries;
}
