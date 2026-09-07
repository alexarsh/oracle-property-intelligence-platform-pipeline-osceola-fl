/**
 * Playwright session for bbb.org.
 *
 * bbb.org sits behind Cloudflare bot management: plain `fetch`/curl get a 403,
 * and even a real browser is periodically shown a managed challenge
 * ("Just a moment…", HTTP 403, `/cdn-cgi/challenge-platform/…` scripts,
 * `__cf_chl_rt_tk` appended to the URL). The challenge resolves itself in a
 * JS-capable browser after a few seconds, after which the `cf_clearance`
 * cookie keeps the context clean for a while. This module therefore:
 *
 * - keeps ONE browser context (cookies) and ONE page for the whole harvest;
 * - after every navigation polls for the challenge to clear
 *   (`challengeAttempts` × `challengeCheckIntervalMs`, with one reload half way),
 *   throwing {@link BbbChallengeError} (transient) only when it does not;
 * - exposes {@link BbbSession.fetchJson} which runs a same-origin `fetch` inside
 *   the page so BBB's `/api/search` can be used with the page's cookies;
 * - records the latency of every request for the summary percentiles.
 *
 * @module sources/bbb/browser
 */
import type { Logger } from "pino";
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "playwright";
import { BBB_ORIGIN } from "./normalize.js";

/** Desktop Chrome UA; Playwright's default announces `HeadlessChrome`, which BBB challenges more often. */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export interface BbbSessionOptions {
  /** Default `true`. Set `false` when challenges never clear headless. */
  headless?: boolean;
  /**
   * Playwright browser channel. Default `"chrome"` (the installed Google
   * Chrome: 0 challenges in 300+ profile navigations on 2026-09-07, versus a
   * ~50 % managed-challenge rate for Playwright's bundled Chromium, which also
   * never clears them in-window). When the channel is not installed the
   * session falls back to the bundled Chromium; pass `null` to force it.
   */
  channel?: string | null;
  userAgent?: string;
  viewport?: { width: number; height: number };
  /** Navigation timeout (ms). Default 60 000. */
  navTimeoutMs?: number;
  /** How many times to re-check a challenge page (per round) before clearing cookies and re-navigating. Default 2. */
  challengeAttempts?: number;
  /** Interval between challenge checks (ms). Default 2 500. */
  challengeCheckIntervalMs?: number;
  /** Fresh-cookie navigation rounds per URL before {@link BbbChallengeError}. Default 3. */
  challengeRounds?: number;
  /**
   * Abort image/font/media and ad/analytics requests. Default `false`: in the
   * 2026-09-07 probes the managed challenge stopped clearing in headless
   * Chromium as soon as these were blocked — the interstitial also
   * fingerprints how "normal" the page load looks. Enable only to save
   * bandwidth when the IP is in good standing.
   */
  blockThirdParty?: boolean;
  /** Extra Chromium flags; `--disable-blink-features=AutomationControlled` is always added. */
  launchArgs?: string[];
  logger?: Logger;
}

/** Result of a page navigation. */
export interface FetchedPage {
  url: string;
  /** Final URL after redirects / challenge resolution. */
  finalUrl: string;
  status: number;
  html: string;
  title: string;
  latencyMs: number;
  /** True when a challenge was shown and cleared during this navigation. */
  challenged: boolean;
}

/** Result of an in-page same-origin `fetch`. */
export interface FetchedJson {
  url: string;
  status: number;
  contentType: string;
  text: string;
  /** Parsed body when the response was JSON; `null` otherwise. */
  json: unknown;
  latencyMs: number;
}

/** Counters the session accumulates. */
export interface SessionStats {
  requestCount: number;
  challengeCount: number;
  latenciesMs: number[];
}

/** What the harvester needs from a browser; {@link openBbbSession} is the real one, tests inject fakes. */
export interface BbbSession {
  /** Navigate the shared page to `url`, wait out any challenge, return the HTML. */
  gotoHtml(url: string): Promise<FetchedPage>;
  /** Same-origin `fetch` inside the current page (must be on bbb.org). */
  fetchJson(pathOrUrl: string): Promise<FetchedJson>;
  stats(): SessionStats;
  close(): Promise<void>;
}

/** Cloudflare challenge did not clear within the configured attempts (transient). */
export class BbbChallengeError extends Error {
  constructor(
    readonly url: string,
    readonly attempts: number,
  ) {
    super(`Cloudflare challenge did not clear after ${attempts} checks: ${url}`);
    this.name = "BbbChallengeError";
  }
}

/** Non-2xx page that is not a challenge. `permanent` is false for 429/5xx. */
export class BbbHttpError extends Error {
  readonly permanent: boolean;
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`HTTP ${status}: ${url}`);
    this.name = "BbbHttpError";
    this.permanent = !(status >= 500 || status === 429 || status === 408);
  }
}

/**
 * Does this HTML (and status) look like Cloudflare's challenge interstitial?
 * Checks the title ("Just a moment…" / "Attention Required"), the
 * challenge-platform script, and the `__cf_chl` markers. A real BBB page
 * always carries `__PRELOADED_STATE__`, so its presence vetoes the heuristic.
 */
export function isChallengeHtml(html: string, status?: number): boolean {
  if (html.includes("window.__PRELOADED_STATE__")) return false;
  const head = html.slice(0, 20_000);
  if (/<title>[^<]*(just a moment|attention required|access denied|checking your browser)/i.test(head)) return true;
  if (/cdn-cgi\/challenge-platform/.test(html) && !/<main/i.test(html)) return true;
  if (/__cf_chl_(?:rt_)?tk|cf-turnstile|challenge-error-text/.test(html)) return true;
  return status === 403 && html.length < 40_000;
}

/** Promise-based sleep; `ms <= 0` resolves on the next tick. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** `ms` ± 20 %, so the request rhythm is not perfectly regular. */
export function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/** Nearest-rank percentile (`p` in 0..100) of an unsorted sample; 0 for an empty sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

/**
 * Launch Chromium and open one context + page for the harvest.
 *
 * Tries the bundled Chromium by default; pass `channel: "chrome"` to use the
 * installed Google Chrome, and `headless: false` as a last resort.
 */
export async function openBbbSession(options: BbbSessionOptions = {}): Promise<BbbSession> {
  const log = options.logger;
  const navTimeoutMs = options.navTimeoutMs ?? 60_000;
  const challengeAttempts = options.challengeAttempts ?? 2;
  const challengeCheckIntervalMs = options.challengeCheckIntervalMs ?? 2_500;
  const challengeRounds = options.challengeRounds ?? 3;

  const launch: LaunchOptions = {
    headless: options.headless ?? true,
    // Hides `navigator.webdriver`; Cloudflare's managed challenge checks it.
    args: ["--disable-blink-features=AutomationControlled", ...(options.launchArgs ?? [])],
  };
  const channel = options.channel === undefined ? "chrome" : options.channel;
  let browser: Browser;
  if (channel) {
    try {
      browser = await chromium.launch({ ...launch, channel });
    } catch (err) {
      if (options.channel !== undefined) throw err;
      log?.warn({ channel, err: err instanceof Error ? err.message.split("\n")[0] : String(err) }, "browser channel unavailable; using bundled Chromium");
      browser = await chromium.launch(launch);
    }
  } else {
    browser = await chromium.launch(launch);
  }
  const context: BrowserContext = await browser.newContext({
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    viewport: options.viewport ?? { width: 1366, height: 860 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  if (options.blockThirdParty ?? false) {
    // Trim third-party noise (ads/analytics) — fewer requests, faster loads, no effect on BBB's own responses.
    await context.route(/\.(png|jpe?g|gif|webp|svg|woff2?|mp4)(\?|$)/, (route) => route.abort());
    await context.route(/(doubleclick|googletagmanager|google-analytics|googlesyndication|facebook|adobedtm|mouseflow|demdex|omtrdc)\./, (route) =>
      route.abort(),
    );
  }
  const page: Page = await context.newPage();
  page.setDefaultNavigationTimeout(navTimeoutMs);

  const stats: SessionStats = { requestCount: 0, challengeCount: 0, latenciesMs: [] };

  async function snapshot(): Promise<{ html: string; title: string }> {
    return { html: await page.content(), title: await page.title() };
  }

  /**
   * Navigate and return as soon as the page is usable: BBB inlines the store
   * in the first script, so waiting for `__PRELOADED_STATE__` (or the
   * document to finish parsing, for challenge / error pages) is several
   * seconds faster than `domcontentloaded`, which waits for every synchronous
   * ad/analytics script.
   */
  async function navigate(url: string): Promise<number> {
    const response = await page.goto(url, { waitUntil: "commit" });
    await page
      .waitForFunction("window.__PRELOADED_STATE__ !== undefined || document.readyState !== 'loading'", undefined, { timeout: navTimeoutMs })
      .catch(() => undefined);
    return response?.status() ?? 200;
  }

  async function gotoHtml(url: string): Promise<FetchedPage> {
    const t0 = Date.now();
    let challenged = false;
    // Observed: the managed challenge rarely solves itself in headless Chromium, but a fresh
    // navigation after clearing cookies is usually not challenged at all. So: short wait, then
    // clear + retry, up to `challengeRounds` times, before giving up.
    for (let round = 1; ; round++) {
      let status = await navigate(url);
      let { html, title } = await snapshot();
      if (!isChallengeHtml(html, status)) {
        const latencyMs = Date.now() - t0;
        stats.requestCount++;
        stats.latenciesMs.push(latencyMs);
        if (status < 200 || status >= 300) throw new BbbHttpError(url, status);
        return { url, finalUrl: page.url(), status, html, title, latencyMs, challenged };
      }
      challenged = true;
      stats.challengeCount++;
      log?.warn({ url, status, title, round }, "bbb challenge shown; waiting for it to clear");
      let cleared = false;
      for (let attempt = 1; attempt <= challengeAttempts; attempt++) {
        await sleep(challengeCheckIntervalMs);
        ({ html, title } = await snapshot());
        if (!isChallengeHtml(html, status)) {
          cleared = true;
          break;
        }
      }
      if (cleared) {
        log?.info({ url, round }, "bbb challenge cleared");
        const latencyMs = Date.now() - t0;
        stats.requestCount++;
        stats.latenciesMs.push(latencyMs);
        return { url, finalUrl: page.url(), status: 200, html, title, latencyMs, challenged };
      }
      // A context that failed a managed challenge keeps failing it; a fresh attempt needs fresh cookies.
      await context.clearCookies().catch(() => undefined);
      if (round >= challengeRounds) {
        stats.requestCount++;
        stats.latenciesMs.push(Date.now() - t0);
        throw new BbbChallengeError(url, challengeAttempts * challengeRounds);
      }
      await sleep(challengeCheckIntervalMs);
    }
  }

  async function fetchJson(pathOrUrl: string): Promise<FetchedJson> {
    const url = new URL(pathOrUrl, BBB_ORIGIN).href;
    const t0 = Date.now();
    const r = await page.evaluate(async (u: string) => {
      const res = await fetch(u, { headers: { accept: "application/json" }, credentials: "same-origin" });
      return { status: res.status, contentType: res.headers.get("content-type") ?? "", text: await res.text() };
    }, url);
    const latencyMs = Date.now() - t0;
    stats.requestCount++;
    stats.latenciesMs.push(latencyMs);
    let json: unknown = null;
    if (/json/i.test(r.contentType)) {
      try {
        json = JSON.parse(r.text) as unknown;
      } catch {
        json = null;
      }
    }
    if (json === null && isChallengeHtml(r.text, r.status)) stats.challengeCount++;
    return { url, status: r.status, contentType: r.contentType, text: r.text, json, latencyMs };
  }

  return {
    gotoHtml,
    fetchJson,
    stats: () => ({ ...stats, latenciesMs: [...stats.latenciesMs] }),
    close: async () => {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}
