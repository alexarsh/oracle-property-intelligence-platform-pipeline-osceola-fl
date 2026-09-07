/**
 * General search on the Accela Citizen Access portal: build the ASP.NET async
 * postback, decode the MS Ajax "delta" response, parse the result grid, and
 * walk the pager while carrying `__VIEWSTATE` forward.
 *
 * How the portal works (verified against captured traffic):
 * 1. `GET CapHome.aspx?module=Building&TabName=Building` returns the search
 *    form and the initial hidden fields (`__VIEWSTATE`, generator, …) plus the
 *    session cookie.
 * 2. Searching is an UpdatePanel async postback: POST the whole form with
 *    `__ASYNCPOST=true`, `X-MicrosoftAjax: Delta=true`, the ScriptManager
 *    field `ctl00$ScriptManager1=<panel>|<control>` and the search button
 *    `ctl00$PlaceHolderMain$btnNewSearch=Search`.
 * 3. The response is not HTML but a pipe-delimited delta:
 *    `len|type|id|content|len|type|id|content|…` where `updatePanel`
 *    segments hold the refreshed panel HTML and `hiddenField` segments hold
 *    the NEW `__VIEWSTATE` etc. that the next postback must send back.
 * 4. Paging is another async postback whose `__EVENTTARGET` is the pager
 *    link's control id (`ctl00$PlaceHolderMain$dgvPermitList$gdvPermitList$ctl13$ctl03`
 *    for page 2 on a 10-row page — the ids are positional, so we always read
 *    them from the pager markup instead of guessing) and whose ScriptManager
 *    field names the grid's UpdatePanel. The response then contains only
 *    `ctl00_PlaceHolderMain_dgvPermitList_updatePanel`. Do not touch
 *    `lblNeedReBind`: forcing it to "false" makes the grid rebind to page 1.
 * 5. The caption reads `Showing 1-10 of 100+` once a search hits the portal's
 *    100-record cap; the `+` is the only cap signal.
 *
 * @module sources/accela/search
 */
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { AccelaClient } from "./client.js";
import { cleanText, toIsoDate, toPortalDate } from "./normalize.js";
import {
  CAP_HOME_URL,
  PORTAL_BASE_URL,
  PORTAL_HIT_CAP,
  type CapId,
  type SearchPage,
  type SearchRow,
} from "./types.js";

/** Prefix of every general-search form field. */
const FORM_PREFIX = "ctl00$PlaceHolderMain$generalSearchForm$";
const SEARCH_BUTTON = "ctl00$PlaceHolderMain$btnNewSearch";
const SCRIPT_MANAGER = "ctl00$ScriptManager1";
/** UpdatePanel that owns the search button (initial search postback). */
const UPDATE_PANEL = "ctl00$PlaceHolderMain$updatePanel";
/**
 * UpdatePanel that owns the result grid. The pager postback MUST name this
 * panel in the ScriptManager field: with the search-form panel the server only
 * re-renders the form and the grid never comes back (verified live).
 */
const GRID_UPDATE_PANEL = "ctl00$PlaceHolderMain$dgvPermitList$updatePanel";
const GRID_ID = "ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList";

/** Decoded MS Ajax delta response. */
export interface AjaxDelta {
  /** Panel client id → refreshed inner HTML. */
  panels: Map<string, string>;
  /** Hidden field name → new value (`__VIEWSTATE`, `__EVENTVALIDATION`, `ACA_CS_FIELD`, …). */
  hiddenFields: Map<string, string>;
  /** Set when the server answered with `pageRedirect` (session lost, error page). */
  redirect: string | null;
  /** Set when the server answered with an `error` segment. */
  error: string | null;
}

/** True when a response body looks like an MS Ajax delta rather than HTML. */
export function isAjaxDelta(body: string): boolean {
  // The first segment is the protocol version: `1|#||4|`, so the type field may be `#`.
  return /^\s*\d+\|[^|]*\|[^|]*\|/.test(body);
}

/**
 * Decode a pipe-delimited MS Ajax delta. Lengths are JavaScript string
 * lengths (UTF-16 code units), which is what `.slice` uses, so the decode is
 * exact for the same decoded text the server measured.
 */
export function parseAjaxDelta(body: string): AjaxDelta {
  const delta: AjaxDelta = { panels: new Map(), hiddenFields: new Map(), redirect: null, error: null };
  let i = 0;
  const text = body.replace(/^\s+/, "");
  while (i < text.length) {
    const p1 = text.indexOf("|", i);
    if (p1 < 0) break;
    const len = Number.parseInt(text.slice(i, p1), 10);
    if (!Number.isFinite(len)) break;
    const p2 = text.indexOf("|", p1 + 1);
    const p3 = text.indexOf("|", p2 + 1);
    if (p2 < 0 || p3 < 0) break;
    const type = text.slice(p1 + 1, p2);
    const id = text.slice(p2 + 1, p3);
    const content = text.slice(p3 + 1, p3 + 1 + len);
    if (type === "updatePanel") delta.panels.set(id, content);
    else if (type === "hiddenField") delta.hiddenFields.set(id, content);
    else if (type === "pageRedirect") delta.redirect = decodeURIComponent(content);
    else if (type === "error") delta.error = `${id}: ${content}`;
    i = p3 + 1 + len + 1; // skip trailing pipe
  }
  return delta;
}

/** Collect `<input type="hidden">` name/value pairs from an HTML fragment or page. */
export function extractHiddenFields(html: string): Map<string, string> {
  const $ = cheerio.load(html);
  const out = new Map<string, string>();
  $("input[type=hidden]").each((_, el) => {
    const name = el.attribs["name"];
    if (name) out.set(name, el.attribs["value"] ?? "");
  });
  return out;
}

/** Parameters of one general search. */
export interface SearchParams {
  recordType: string;
  /** ISO dates, inclusive. */
  since: string;
  until: string;
}

/**
 * Build the form for the initial search postback from the hidden fields of
 * the CapHome page. Only the fields the probe proved necessary are set; the
 * rest of the search form is left at its server-side defaults.
 */
export function buildSearchForm(hidden: ReadonlyMap<string, string>, params: SearchParams): URLSearchParams {
  const form = new URLSearchParams();
  for (const [k, v] of hidden) form.set(k, v);
  form.set("__EVENTTARGET", "");
  form.set("__EVENTARGUMENT", "");
  form.set("__LASTFOCUS", "");
  form.set(`${FORM_PREFIX}ddlGSPermitType`, params.recordType);
  form.set(`${FORM_PREFIX}txtGSStartDate`, toPortalDate(params.since));
  form.set(`${FORM_PREFIX}txtGSEndDate`, toPortalDate(params.until));
  form.set(SCRIPT_MANAGER, `${UPDATE_PANEL}|${SEARCH_BUTTON}`);
  form.set(SEARCH_BUTTON, "Search");
  form.set("__ASYNCPOST", "true");
  return form;
}

/**
 * Derive the next postback form from the previous one and the delta it
 * produced: carry the new hidden fields forward, drop the search button and
 * target the pager link instead.
 */
export function buildPagerForm(previous: URLSearchParams, delta: AjaxDelta, target: string): URLSearchParams {
  const form = new URLSearchParams(previous);
  form.delete(SEARCH_BUTTON);
  // Hidden inputs rendered inside the refreshed panels (grid selection state, rebind flags)
  // are part of the browser's form too; hidden-field segments win because they are newer.
  for (const html of delta.panels.values()) for (const [k, v] of extractHiddenFields(html)) form.set(k, v);
  for (const [k, v] of delta.hiddenFields) form.set(k, v);
  form.set("__EVENTTARGET", target);
  form.set("__EVENTARGUMENT", "");
  form.set(SCRIPT_MANAGER, `${GRID_UPDATE_PANEL}|${target}`);
  form.set("__ASYNCPOST", "true");
  return form;
}

/** Headers that make ASP.NET treat the POST as a partial-rendering request. */
const ASYNC_HEADERS: Record<string, string> = {
  "X-MicrosoftAjax": "Delta=true",
  "X-Requested-With": "XMLHttpRequest",
  Referer: CAP_HOME_URL,
  Accept: "*/*",
};

/** Parse `capID1/2/3` from a CapDetail link. */
export function capIdFromUrl(url: string): CapId | null {
  let u: URL;
  try {
    u = new URL(url, PORTAL_BASE_URL);
  } catch {
    return null;
  }
  const capID1 = u.searchParams.get("capID1");
  const capID2 = u.searchParams.get("capID2");
  const capID3 = u.searchParams.get("capID3");
  return capID1 && capID2 && capID3 ? { capID1, capID2, capID3 } : null;
}

const POSTBACK_RE = /__doPostBack\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/;

/** Pull the `__EVENTTARGET` out of a `javascript:__doPostBack('target','arg')` href. */
export function postbackTarget(href: string | undefined): string | null {
  if (!href) return null;
  const m = POSTBACK_RE.exec(href.replace(/&#39;|&apos;/g, "'"));
  return m ? m[1]! : null;
}

function parseRow($: CheerioAPI, tr: ReturnType<CheerioAPI>): SearchRow | null {
  const text = (suffix: string): string | null => cleanText(tr.find(`span[id$=${suffix}]`).first().text());
  const link = tr.find("a[href*='CapDetail.aspx']").first();
  const href = link.attr("href");
  const detailUrl = href ? new URL(href, PORTAL_BASE_URL).toString() : null;
  // Linked rows render the number in `lblPermitNumber1` inside the anchor; list-only rows in `lblPermitNumber`.
  const permitNumber = text("lblPermitNumber1") ?? text("lblPermitNumber") ?? cleanText(link.text());
  if (permitNumber == null) return null;
  const recordId = cleanText(tr.find("input[id=RecordId]").attr("value"));
  return {
    permitNumber,
    recordId,
    capId: detailUrl ? capIdFromUrl(detailUrl) : null,
    detailUrl,
    date: toIsoDate(text("lblUpdatedTime")),
    recordType: text("lblType"),
    projectName: text("lblProjectName"),
    address: text("lblAddress") ?? text("lblPermitAddress"),
    status: text("lblStatus"),
    description: text("lblDescription"),
    expirationDate: toIsoDate(text("lblExpirationDate")),
    shortNote: text("lblShortNote"),
  };
}

/**
 * Parse a result page. Accepts either the raw MS Ajax delta body (as returned
 * by the portal) or plain HTML containing the grid. Never throws on an empty
 * result: rows are `[]` and `total` is `0` when the portal says so.
 */
export function parseSearchResults(html: string): SearchPage {
  const source = isAjaxDelta(html) ? [...parseAjaxDelta(html).panels.values()].join("\n") : html;
  const $ = cheerio.load(source);
  const grid = $(`#${GRID_ID}`);

  const rows: SearchRow[] = [];
  grid.find("tr.ACA_TabRow_Odd, tr.ACA_TabRow_Even").each((_, tr) => {
    const row = parseRow($, $(tr));
    if (row) rows.push(row);
  });

  const captionText = cleanText(grid.find(".aca_gridview_caption").text()) ?? cleanText($.text()) ?? "";
  const showingMatch = /Showing\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)\s*(\+?)/i.exec(captionText);
  let total: number | null = null;
  let showing: SearchPage["showing"] = null;
  let plus = false;
  if (showingMatch) {
    showing = { from: Number(showingMatch[1]), to: Number(showingMatch[2]) };
    total = Number(showingMatch[3]);
    plus = showingMatch[4] === "+";
  } else if (grid.length === 0 && /no results|no records|returned no/i.test($.text())) {
    total = 0;
  }

  const pageCountAttr = Number(grid.attr("pagecount") ?? grid.attr("PageCount"));
  const pageCount = Number.isFinite(pageCountAttr) && pageCountAttr > 0 ? pageCountAttr : null;
  const pager = grid.find("td.aca_pagination_td").closest("tr").first();
  const currentPage = Number(cleanText(pager.find("span.SelectedPageButton").first().text()) ?? "1") || 1;
  let nextPageTarget: string | null = null;
  pager.find("a").each((_, a) => {
    if (nextPageTarget) return;
    const label = cleanText($(a).text());
    if (label === String(currentPage + 1)) nextPageTarget = postbackTarget($(a).attr("href"));
  });
  if (!nextPageTarget) {
    pager.find("a").each((_, a) => {
      if (nextPageTarget) return;
      const label = cleanText($(a).text()) ?? "";
      if (/^Next\b/i.test(label)) nextPageTarget = postbackTarget($(a).attr("href"));
    });
  }

  return {
    rows,
    total,
    hasNextPage: nextPageTarget !== null,
    capped: plus || (total !== null && total >= PORTAL_HIT_CAP),
    nextPageTarget,
    currentPage,
    pageCount,
    showing,
  };
}

/** Raised when the portal answers a search postback with something other than a result panel. */
export class SearchProtocolError extends Error {
  override readonly name = "SearchProtocolError";
}

export interface IterateSearchOptions {
  /** Stop after the first page when it is capped (the caller will split the window). */
  stopWhenCapped?: boolean;
  /** Pause between page postbacks. */
  minDelayMs?: number;
  /** Hard stop on page count; the cap makes >10 pages impossible, so this only guards against pager loops. */
  maxPages?: number;
}

/**
 * Run one general search and yield every result page in order. Search
 * requests are sequential by nature (each postback depends on the previous
 * `__VIEWSTATE`), so this never runs in parallel.
 */
export async function* iterateSearchPages(
  client: AccelaClient,
  params: SearchParams,
  options: IterateSearchOptions = {},
): AsyncGenerator<SearchPage, void, undefined> {
  const maxPages = options.maxPages ?? 25;
  const home = await client.get(CAP_HOME_URL);
  const hidden = extractHiddenFields(home.body);
  if (!hidden.has("__VIEWSTATE")) throw new SearchProtocolError("CapHome page has no __VIEWSTATE (bot page or portal change)");

  let form = buildSearchForm(hidden, params);
  for (let page = 1; page <= maxPages; page++) {
    const res = await client.postForm(CAP_HOME_URL, form, ASYNC_HEADERS);
    if (!isAjaxDelta(res.body)) throw new SearchProtocolError("search postback did not return an MS Ajax delta");
    const delta = parseAjaxDelta(res.body);
    if (delta.error) throw new SearchProtocolError(`portal error during search: ${delta.error}`);
    if (delta.redirect) throw new SearchProtocolError(`portal redirected during search: ${delta.redirect}`);
    const parsed = parseSearchResults(res.body);
    if (page > 1 && parsed.rows.length === 0 && parsed.showing === null) {
      // A pager postback that comes back without the grid means the postback was malformed
      // (wrong UpdatePanel, stale viewstate). Silently ending here would under-harvest the window.
      throw new SearchProtocolError(`pager postback for page ${page} returned no result grid`);
    }
    yield parsed;
    if (!parsed.hasNextPage || !parsed.nextPageTarget) return;
    if (options.stopWhenCapped && parsed.capped) return;
    form = buildPagerForm(form, delta, parsed.nextPageTarget);
    if (options.minDelayMs) await new Promise((r) => setTimeout(r, options.minDelayMs));
  }
}
