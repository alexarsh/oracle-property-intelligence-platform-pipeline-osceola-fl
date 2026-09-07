/**
 * HTTP client for the Osceola Accela portal: TLS chain repair, a per-session
 * cookie jar, latency accounting, and retry classification.
 *
 * Portal behaviour worth knowing:
 * - `permits.osceola.org` omits the Entrust intermediate from its TLS chain,
 *   so a stock Node `fetch` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. We
 *   hand undici an `Agent` whose CA set is Node's bundled roots plus that
 *   intermediate — no `NODE_EXTRA_CA_CERTS` and no `rejectUnauthorized=false`.
 * - Async postbacks need the ASP.NET session cookie that the first GET sets;
 *   the client keeps a simple name→value jar per instance.
 * - Every request (including retries) is timed; the harvest summary reports
 *   p50/p95 over all of them.
 *
 * @module sources/accela/client
 */
import tls from "node:tls";
import { Agent, type Dispatcher } from "undici";
import type { Logger } from "pino";
import { ENTRUST_OV_TLS_ISSUING_RSA_CA_2_PEM } from "./certs/index.js";

/** Desktop browser UA: the portal serves a JS-less "unsupported browser" page to bots/empty UAs. */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Error for conditions that may clear on retry: 5xx, 429, 408, network, timeout. */
export class TransientHttpError extends Error {
  override readonly name = "TransientHttpError";
  constructor(
    message: string,
    readonly status: number | null,
    /** HTTP attempts made when the error was raised. */
    readonly attempts: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Error for conditions a retry cannot fix: 404/410 and other 4xx. */
export class PermanentHttpError extends Error {
  override readonly name = "PermanentHttpError";
  constructor(
    message: string,
    readonly status: number,
    readonly attempts: number,
  ) {
    super(message);
  }
}

/** Successful (2xx) response, body fully read. */
export interface HttpResult {
  status: number;
  body: string;
  /** Final URL after redirects. */
  url: string;
}

export interface AccelaClientOptions {
  /** Injected fetch (tests). Defaults to the global fetch with the pinned dispatcher attached. */
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Per-attempt timeout, default 45 s (the portal's own async timeout is 90 s). */
  timeoutMs?: number;
  /** Total attempts for transient failures, default 4. */
  maxAttempts?: number;
  /** Backoff base, default 750 ms; attempt n sleeps `base * 2^(n-1)` before retrying. */
  retryBaseDelayMs?: number;
  userAgent?: string;
}

/** Stateful client bound to one portal session. */
export interface AccelaClient {
  /** GET with retries; resolves only for 2xx. */
  get(url: string, headers?: Record<string, string>): Promise<HttpResult>;
  /** `application/x-www-form-urlencoded` POST with retries; resolves only for 2xx. */
  postForm(url: string, form: URLSearchParams, headers?: Record<string, string>): Promise<HttpResult>;
  /** Wall-clock milliseconds of every attempt made so far (successful or not). */
  readonly latenciesMs: readonly number[];
  /** Number of HTTP attempts made so far. */
  readonly requestCount: number;
  /** Current `Cookie` header value for the session. */
  cookieHeader(): string;
}

let pinnedDispatcher: Dispatcher | undefined;

/**
 * Build (once) an undici dispatcher that trusts Node's bundled roots plus the
 * Entrust intermediate the portal fails to send. Node's default CA store is
 * not reachable from `connect.ca`, hence the explicit `tls.rootCertificates`.
 */
export function createPinnedDispatcher(): Dispatcher {
  pinnedDispatcher ??= new Agent({
    connect: { ca: [...tls.rootCertificates, ENTRUST_OV_TLS_ISSUING_RSA_CA_2_PEM] },
    keepAliveTimeout: 10_000,
  });
  return pinnedDispatcher;
}

/** Classify an HTTP status for the retry policy. */
export function classifyStatus(status: number): "ok" | "transient" | "permanent" {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 500 || status === 429 || status === 408) return "transient";
  return "permanent";
}

/** Nearest-rank percentile (`p` in 0..100) of an unsorted sample; 0 for an empty sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

/** Promise-based sleep; `ms <= 0` resolves on the next tick. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Create a client. Each instance owns its cookie jar and latency log. */
export function createAccelaClient(options: AccelaClientOptions = {}): AccelaClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const dispatcher = options.fetchImpl ? undefined : createPinnedDispatcher();
  const timeoutMs = options.timeoutMs ?? 45_000;
  const maxAttempts = options.maxAttempts ?? 4;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 750;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const logger = options.logger;
  const cookies = new Map<string, string>();
  const latenciesMs: number[] = [];

  const cookieHeader = (): string =>
    [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

  const absorbCookies = (res: Response): void => {
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };

  async function request(url: string, init: RequestInit, extraHeaders: Record<string, string>): Promise<HttpResult> {
    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = { "User-Agent": userAgent, ...extraHeaders };
      const cookie = cookieHeader();
      if (cookie) headers["Cookie"] = cookie;
      const baseInit: RequestInit = { ...init, headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" };
      // `dispatcher` is an undici extension of RequestInit; the `undici` package and Node's bundled
      // `undici-types` declare structurally different Dispatcher types, hence the cast.
      const requestInit = dispatcher ? ({ ...baseInit, dispatcher } as unknown as RequestInit) : baseInit;

      const started = Date.now();
      let res: Response;
      let body: string;
      try {
        res = await fetchImpl(url, requestInit);
        absorbCookies(res);
        body = await res.text();
      } catch (err) {
        latenciesMs.push(Date.now() - started);
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        logger?.warn({ url, attempt, err: message }, "accela request failed (network/timeout)");
        if (attempt >= maxAttempts) throw new TransientHttpError(`network failure after ${attempt} attempts: ${message}`, null, attempt, { cause: err });
        await sleep(retryBaseDelayMs * 2 ** (attempt - 1));
        continue;
      }
      latenciesMs.push(Date.now() - started);

      const cls = classifyStatus(res.status);
      if (cls === "ok") return { status: res.status, body, url: res.url || url };
      if (cls === "permanent") throw new PermanentHttpError(`HTTP ${res.status} for ${url}`, res.status, attempt);
      logger?.warn({ url, attempt, status: res.status }, "accela request failed (transient status)");
      if (attempt >= maxAttempts) throw new TransientHttpError(`HTTP ${res.status} after ${attempt} attempts for ${url}`, res.status, attempt);
      await sleep(retryBaseDelayMs * 2 ** (attempt - 1));
    }
  }

  return {
    get: (url, headers = {}) => request(url, { method: "GET" }, headers),
    postForm: (url, form, headers = {}) =>
      request(
        url,
        { method: "POST", body: form.toString() },
        { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", ...headers },
      ),
    latenciesMs,
    get requestCount() {
      return latenciesMs.length;
    },
    cookieHeader,
  };
}
