# BBB roofing-contractor profile harvester (Central Florida / Osceola service area)

Source: `OSCEOLA.sources.bbb_roofing` — <https://www.bbb.org/us/fl/kissimmee/category/roofing-contractors>
(BBB Serving Central Florida, bureau id `0733`). National data source, harvested per the kit's
`bbb-harvest` skill as a public-site category crawl (no API token). Output feeds
`raw_bbb_profiles` via `duckdb/load-harvests.ts` and, from there, the contractor
match cascade (license number → 10-digit phone → cleaned name).

## Module layout

| File | Responsibility |
| --- | --- |
| `browser.ts` | Playwright session: one Chromium context + page for the whole run, Cloudflare challenge wait/retry loop, same-origin `fetch` inside the page (`fetchJson`), request/latency/challenge counters |
| `category.ts` | Listing parsers: `parseCategoryPage(html)` (embedded state → markup fallback) and `parseSearchResult(json)` for `/api/search`; URL / API-path builders |
| `profile.ts` | `parseProfilePage(html, url)`: contract fields + `extra` (service counties, alt names, website, complaint windows, license agency …) |
| `normalize.ts` | `parseBbbId`, `normalizePhone` (10 digits), `normalizeLicense` / `extractLicenseNumbers` (FL DBPR shapes), `normalizeRating` (13 letter grades), `stripTags` |
| `preloaded-state.ts` | `window.__PRELOADED_STATE__` extraction (string-aware brace matching) and typed accessors |
| `harvest.ts` | `harvestBbb`: city × category × sort listing walk, bbbId de-duplication, profile fetch with retries, JSONL/summary writing, resume |
| `index.ts` | Public surface |
| `__fixtures__/` | Real pages fetched 2026-09-07: one category page (`?page=2`), one `/api/search` body (`sort=Distance`), two profiles |

## How bbb.org behaves (observed 2026-09-07, US VPN egress)

1. **Plain HTTP is blocked.** `curl`/`fetch` get HTTP 403 from Cloudflare for HTML pages;
   static assets on `assets.bbb.org` are open. A real browser is required.
2. **Pages are a Redux app with the store inlined.** Every page carries
   `window.__PRELOADED_STATE__ = {...}` in a `<script>`:
   * category pages → `searchResult` (`page`, `pageSize`, `totalPages`, `totalResults`,
     `results[]`, `heading.searchInputText`, `heading.searchLocationText`, `sortTypes`, `filters`);
   * profile pages → `businessProfile` (`names.primary`, `rating.bbbRating`,
     `accreditationInformation.isAccredited`, `reviewsComplaintsSummary.{reviewsTotal,complaintsTotal,totalClosedComplaintsPastThreeYears,…}`,
     `contactInformation.phoneNumber`, `location.postalAddress`, `categories.links[]`,
     `orgDetails.license.details[].licenseNumber` + `licenseAgency`, `location.servingAreas[].countyStates[]`).
   The parsers read the store first and fall back to markup / schema.org JSON-LD only when it is absent.
3. **Same-origin search API.** The listing app calls `GET /api/search?find_country=USA&find_text=<text>&find_loc=<City, ST>&page=N[&sort=Relevance|Distance|Rating|AToZ|ZToA][&filter_category=<tobId>]`
   and gets exactly the `searchResult` JSON. It is callable with `fetch` from inside a bbb.org page
   (cookies + clearance travel with it), so after one real navigation per city the harvester lists
   through JSON and only navigates for profiles. Called from outside a page context it is 403.
4. **Hard listing cap.** `pageSize` is fixed at 15 and `totalPages` is capped at 15 (page 16 →
   HTTP 500) even though `totalResults` for "Roofing Contractors near Kissimmee" is ~6 200 (the
   pool is a fuzzy relevance match that includes general contractors, restoration firms and
   out-of-state businesses). One (location, text, sort) tuple therefore exposes at most 225
   businesses; each `sort` exposes a different window, which is why the harvester walks
   `Relevance`, `Distance`, `AToZ` and `ZToA` per city and de-duplicates by `bbbId`.
   The advertised `totalResults` is **not** a coverage denominator.
5. **Business identity.** Profile URLs end in `-<bureau>-<business>` (`…-0733-90573947`);
   `bbbId` in the records is that pair (`"0733-90573947"`). Multi-location businesses appear with
   `/addressId/<n>` suffixes and are de-duplicated on the id alone.
6. **Location resolution.** `saint-cloud` is the slug (not `st-cloud`); `celebration` and
   `poinciana` resolve to Osceola County locations, `kissimmee` to Osceola+Polk, `orlando` to Orange.

### The challenge

Cloudflare bot management serves a *managed challenge* — HTTP 403, `<title>Just a moment... | Better Business Bureau®</title>`,
`window._cf_chl_opt = {cType: 'managed', …}`, a script from `/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=…`,
and `?__cf_chl_rt_tk=…` appended to the URL — sporadically on navigations, more often after bursts.
In a JS-capable browser it clears by itself in 3–10 s and sets `cf_clearance`; `isChallengeHtml`
detects it (a real page always contains `__PRELOADED_STATE__`, which vetoes the heuristic) and
`gotoHtml` polls `challengeAttempts × challengeCheckIntervalMs` (default 12 × 2.5 s, one reload half
way) before throwing `BbbChallengeError` (transient → retried by the harvester, cookies cleared first).

What was measured on the full run (same IP, same hour, ~1 000 profile navigations):

| Browser | Challenge rate | Auto-clears in window? | Median page load | Effective pace |
| --- | --- | --- | --- | --- |
| Bundled headless Chromium, third-party requests blocked | 3/3 stuck for 30 s, then `net::ERR_CONNECTION_CLOSED` | no | — | unusable |
| Bundled headless Chromium, nothing blocked | ~52 % of navigations (54/103) | **never** — but a cookie-cleared re-navigation succeeded every time | 13 s (bimodal: ~2 s clean / ~15 s challenged) | 10.8 s/profile |
| Google Chrome (`channel: "chrome"`), headless, nothing blocked | 0 of 300+ | n/a | 0.7 s | 3.0 s/profile (delay-bound) |

Chrome headed also cleared everything in the probe but is slower to start; it was not needed. The
challenge page itself is served in ~2 s, which is why the loop is "one or two short checks, clear cookies,
navigate again" rather than a long wait. Defaults are therefore: `channel: "chrome"` (falls back to the
bundled Chromium with a warning when Chrome is not installed), headless, `--disable-blink-features=AutomationControlled`,
no request blocking, realistic desktop UA/viewport/locale/timezone, `challengeAttempts: 2` × 2.5 s per round,
`challengeRounds: 3`. Escalation path when challenges persist: `headless: false`, then a different egress.
Navigation waits for `window.__PRELOADED_STATE__` (inlined in the first script) instead of `domcontentloaded`,
which otherwise waits several seconds for synchronous ad scripts.

## Request budget

Per city × category: 1 HTML navigation + up to 14 API pages (Relevance) + 15 × 3 API pages (other sorts) = ≤ 60 listing requests.
Five cities → ≤ 300 listing requests (~2.5 s apart plus latency, ~15–20 min). Profiles: one navigation
each for every unique FL business listed (several hundred to ~1 000), `profileDelayMs` apart
(2–2.5 s) plus 1–6 s page load → ~1–1.5 h. One page at a time, one browser context, jittered delays.
`skipExisting` (default) makes re-runs resume: already-written `bbbId`s are not fetched again.

## Output (`data/raw/bbb/<job>/`)

| File | Contents |
| --- | --- |
| `profiles.jsonl` | `BbbProfileRecord` per line, validated with `@osceola/shared` |
| `profiles-extra.jsonl` | `{ bbbId, listing: {…}, extra: ProfileExtras }` — service counties, alt names, website, complaint windows, license agency, entity type … |
| `listings.jsonl` | every search-result item seen, with `{ city, category, sort, page }` provenance (audit of the listing walk) |
| `failures.jsonl` | `{ kind: "listing"\|"profile", bbbId, url, status, message, permanent, at }` — permanent (404/parse) and transient-exhausted alike |
| `summary.json` | `categoryUrls, pagesFetched, profilesFetched, profilesFailed, startedAt, finishedAt, requestCount, p50LatencyMs, p95LatencyMs, challengeCount` + reconciliation extras |
| `raw/listings/*.html\|json`, `raw/profiles/<bbbId>.html` | raw captures (`rawHtmlSha256` in each record is the sha of its profile file) |

Field notes: `rating` is the letter grade or `null` (NR); `ratingScore` comes from the *listing*
(profiles do not expose the numeric score) and is `null` when the listing had none; `phone` is ten
digits; `zip` is kept as served (ZIP+4 when BBB has it); `complaintCount` is `complaintsTotal`
(all complaints on file — the 3-year / 12-month closed counts are in `extra`); `licenseNumbers` are
normalised (`CCC 1330-217` → `CCC1330217`) from the licensing block plus any codes found in its notes.

## Coverage caveats

* Listings are relevance/radius searches, not a registry: a business is reachable only if it lands
  in one of the 225-row windows for one of the five cities × four sorts. Roofers whose BBB file is
  thin can be missed; adding sorts (`Rating`), sub-categories (`filter_category`, e.g.
  `10126-210` Residential Roofing, `10126-200` Commercial) or more seed cities widens the net.
* Only FL-state listings are fetched by default (`states: ["FL"]`); out-of-state chains that serve
  Osceola are skipped (counted in `profilesSkippedState`).
* Category text is fuzzy: "Roofing Contractors" results include general contractors, solar,
  gutters and restoration firms. `categories` / `extra.primaryCategory` tell them apart downstream.
* BBB data is self-reported plus complaint records; license numbers are as entered by the business
  and are verified against DBPR only through the pipeline's match cascade.

## Run

```ts
import { harvestBbb } from "./sources/bbb/index.js";
await harvestBbb({ outDir: "data/raw/bbb/roofing-central-fl-2026-09-07" }); // defaults: 5 cities, roofing-contractors, 4 sorts
```

Before any live run confirm US egress: `curl -s ipinfo.io/country` → `US`. Dev dependency:
`playwright` (`npx playwright install chromium` once).

## Run log — `roofing-central-fl-2026-09-07`

Egress: US VPN exit (`ipinfo.io/country` → `US`, checked before every segment). Category:
`roofing-contractors`; cities kissimmee, saint-cloud, celebration, poinciana, orlando; sorts
Relevance, Distance, AToZ, ZToA; `pageDelayMs` 2 500, `profileDelayMs` 2 000. 09:52 → 11:39 UTC.

| | |
| --- | --- |
| Listing pages | 300 (5 HTML + 295 `/api/search`), 0 listing failures; advertised `totalResults` 5 788–6 522 per city, 15-page cap everywhere |
| Listing rows → unique businesses | 4 062 rows → **1 007** unique `bbbId` (all FL); Kissimmee alone yielded 775 after 4 sorts, the other four cities' page 1s were 100 % overlap |
| Profiles | **1 007 / 1 007** fetched and contract-valid, 0 failures, 0 DOM-fallback parses; 147 MB raw HTML |
| Ratings | A+ 566 · A 60 · A- 44 · B+ 2 · B- 28 · C+ 3 · C 4 · C- 1 · D 1 · D- 2 · F 25 · NR 271 |
| Accredited | 400 |
| With license number(s) | 753 (75 %) — all from the "Licensing" block, FL DBPR codes (`CCC…`, `CGC…`, `CBC…`, …) |
| With phone | 975 (97 %) · with street address 793 · with numeric `ratingScore` 1 007 (from listings) |
| With complaints on file | 220 · with reviews 315 · marked out of business 40 |
| Declares Osceola County in its BBB service area | 159 (`extra.servingCounties`) |
| Primary category | Roofing Contractors 801, General Contractor 57, Residential Roofing 17, Commercial Roofing 14, other 118 |
| Business city | Orlando 279, Kissimmee 59, Saint Cloud 32, Winter Haven 28, Jacksonville 25, Winter Park 24, … |
| Requests / latency | 1 320 requests; profile-navigation p50 773 ms, p95 13.8 s (the p95 is the Chromium segments' challenge waits; Chrome segment alone p50 678 ms, p95 2.4 s) |
| Challenges | 68 shown, none auto-cleared, all resolved by cookie-clear + re-navigate; 0 in the Chrome segment |

The job ran as three resumed segments (`skipExisting` + `reuseListings`): bundled Chromium for the
listing walk + 62 profiles (40 s/profile with the original 30 s challenge wait), bundled Chromium with
the short wait (107 profiles, 10.8 s/profile, 52 % challenged), then Google Chrome (838 profiles,
3.0 s/profile, 0 challenged). `summary.json` is the aggregate with a `segments` breakdown;
`summary-last-segment.json` is the harvester's own summary of the final segment. Three failure lines
written by an orphaned child process after its browser was killed were pruned from `failures.jsonl`
(the profiles were fetched normally by the next segment).

Not attempted this run (cheap follow-ups): `general-contractor` and `solar-energy-contractors`
categories, the `Rating` sort, `filter_category` sub-categories.
