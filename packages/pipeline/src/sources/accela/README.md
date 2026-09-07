# Osceola County Accela Citizen Access harvester

Source: `OSCEOLA.sources.osceola_accela` — <https://permits.osceola.org/CitizenAccess/>
(Osceola County Building Office; unincorporated county only — Kissimmee and
St. Cloud run their own permit systems).

## Module layout

| File | Responsibility |
| --- | --- |
| `client.ts` | `fetch` wrapper: TLS chain repair (undici `Agent`, `tls.rootCertificates` + pinned intermediate), cookie jar, timeout, retry classification, latency log |
| `search.ts` | General-search postback, MS Ajax delta decoding, result-grid parser, pager walk with `__VIEWSTATE` carry-over |
| `detail.ts` | `CapDetail.aspx` parser (label-based) |
| `harvest.ts` | `harvestWindow` / `harvestRange`: worker pool, raw archive + `skipExisting`, JSONL + summary writing, cap bisection |
| `normalize.ts` | Parcel / phone / date / money normalisers |
| `types.ts` | Options, `SearchRow`, constants |
| `certs/` | `entrust-ov-tls-issuing-rsa-ca-2.pem` and the same bytes as a TS constant (`tsc` does not copy `.pem` into `dist/`) |
| `__fixtures__/` | Captured delta response (`search-delta-page1.txt`) and two real detail pages |

## How the portal works

1. **Session.** `GET Cap/CapHome.aspx?module=Building&TabName=Building` sets
   `ASP.NET_SessionId` and returns the search form with `__VIEWSTATE`
   (~260 KB), `__VIEWSTATEGENERATOR`, `ACA_CS_FIELD`. A browser-like
   `User-Agent` is required; empty/bot UAs get a JS-less stub page.
2. **Search** is an UpdatePanel async postback to the same URL:
   `__ASYNCPOST=true`, header `X-MicrosoftAjax: Delta=true`,
   `ctl00$ScriptManager1=ctl00$PlaceHolderMain$updatePanel|ctl00$PlaceHolderMain$btnNewSearch`,
   `ctl00$PlaceHolderMain$btnNewSearch=Search`, and the form fields
   `ctl00$PlaceHolderMain$generalSearchForm$ddlGSPermitType` (`Building/Permit/Roofing/NA`),
   `…$txtGSStartDate` / `…$txtGSEndDate` (`MM/DD/YYYY`, inclusive, matched
   against the grid's "Date" column).
3. **Response** is a pipe-delimited MS Ajax delta, `len|type|id|content|…`
   (first segment `1|#||4|` is the protocol version). `updatePanel` segments
   carry the refreshed HTML (`ctl00_PlaceHolderMain_updatePanel2` holds the
   grid); `hiddenField` segments carry the **new** `__VIEWSTATE` etc. that the
   next postback must echo. `pageRedirect` / `error` segments mean the session
   was lost or the server failed — the harvester raises `SearchProtocolError`.
4. **Grid** `#ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList`, 10 rows per
   page, columns: Date (`lblUpdatedTime`), Record Number, Record Type,
   Project Name, Address, Status, Action, Description, Expiration Date,
   Short Notes. Two row kinds:
   * real records — number inside `a[id$=hlPermitNumber]` →
     `CapDetail.aspx?Module=Building&TabName=Building&capID1=REC26&capID2=00000&capID3=00U4X&agencyCode=OSCEOLA&IsToShowInspection=`;
   * temporary / unsubmitted applications — `OSCTEMP26-…` with hidden
     `RecordId=26EST-…`, **no link, no detail page** (written to `list-only.jsonl`).
5. **Paging** is another async postback: `__EVENTTARGET` = the pager link's
   control id, e.g. `ctl00$PlaceHolderMain$dgvPermitList$gdvPermitList$ctl13$ctl03`
   for page 2 (the `ctlNN` are positional, so they are always read from the
   pager markup, never computed), with the previous delta's hidden fields
   echoed back and `ctl00$ScriptManager1=ctl00$PlaceHolderMain$dgvPermitList$updatePanel|<target>`
   — the **grid's** UpdatePanel. Verified live: naming the search-form panel
   instead makes the server re-render only the form (no grid, no caption), and
   forcing `lblNeedReBind=false` rebinds the grid to page 1. Page links are
   numbered; `Next >` and `...` exist too. The harvester picks the link whose
   text equals `currentPage + 1`, falling back to `Next >`. The grid table
   carries `PageCount="11"` for a capped search (exposed as `pageCount`).
6. **Cap.** The caption reads `Showing 1-10 of 100+` once a search matches ≥100
   records; the `+` is the only cap signal (the real total is never shown).
   Roofing permits alone exceed 100 in ~5 days, so windows must be short.
7. **Detail page** (`CapDetail.aspx`, plain GET, ~215 KB, no session needed):
   header `lblPermitNumber` / `lblPermitType` / `lblRecordStatus`; "Record
   Details" with the *Licensed Professional* block (free text: name + email,
   business, street, `CITY, ST, ZIP`, phone table, `LICENSE TYPE LICENSENO`)
   and *Project Description*; the collapsed "More Details" block with
   Application Information (Construction Value, Reroof, Manufacturer, FL#/NOA#,
   Hurricane Related, Owner-Builder, …) and Parcel Information. Fees,
   Inspections, Processing Status and Related Records are lazy-loaded by
   browser JS; the initial HTML only says "Loading...". The
   `shProcessStatus$btnSearch` async postback was probed and returns no panel
   content, so workflow dates are not obtainable without a browser.
8. **TLS.** The server sends only its leaf certificate; the issuer *Entrust OV
   TLS Issuing RSA CA 2* (cross-signed by Sectigo Public Server Authentication
   Root R46) is pinned in `certs/` and handed to undici as
   `connect.ca = [...tls.rootCertificates, pem]`. No `NODE_EXTRA_CA_CERTS`, no
   `rejectUnauthorized: false`.

## Field mapping

| `AccelaPermitRecord` | Source |
| --- | --- |
| `permitNumber`, `capId`, `recordType`, `status`, `description`, `jobValue` ("Construction Value"), `parcelNumber`, `contractor.*`, `sourceUrl` | detail page |
| `openedDate` | search row "Date" column (the detail page shows no dates) |
| `expirationDate` | search row "Expiration Date" column (detail label lookup first, but the page has none) |
| `address` | search row "Address" (the portal has no Work Location block on the detail page) |
| `issuedDate`, `finaledDate`, `closedDate` | **always null** — not exposed in server-rendered HTML (see gap 1) |

Unmapped detail fields are not dropped: `details-extra.jsonl` holds
`{permitNumber, extra: {label: value}}` (Reroof, Manufacturer, FL#/NOA#,
Hurricane Related, Owner-Builder answer, contractor email/phone rows, …).

## Request budget and politeness

* One window = 1 GET + `ceil(hits/10)` search postbacks (max 10) + 1 GET per
  linked record. A capped 7-day roofing window therefore costs ≤ 11 + 100
  requests before splitting.
* `harvestRange` probes a window with **one** search postback; if it is capped
  and spans > 1 day it bisects immediately (no details, no further pages).
  Coverage = union of terminal windows. A single-day window that is still
  capped is paginated to exhaustion and reported `capped: true` (coverage for
  that day may be incomplete — there is no finer filter than a day).
* Detail fetches run on `concurrency` workers (default 2; the reference
  Accela portal degraded above ~4) with `minDelayMs` (default 400 ms) between a
  worker's requests. Search paging is always sequential.
* Retries: 5xx / 429 / 408 / network / timeout → exponential backoff
  (`750 ms × 2^(n-1)`, 4 attempts). 404 and other 4xx, and pages without a
  record header, are permanent: recorded in `failures.jsonl`, never thrown.
* Observed latency (single SK egress, September 2026): detail GET ≈ 1.4–1.8 s,
  search postback ≈ 1–2 s.

## Output layout

```
<outDir>/
  permits.jsonl          merged, deduplicated AccelaPermitRecord lines
  failures.jsonl         {permitNumber,url,error,attempt,kind}
  list-only.jsonl        temporary applications without a detail page
  search-rows.jsonl      every grid row seen (audit)
  details-extra.jsonl    unmapped detail fields
  summary.json           AccelaHarvestSummary for the whole range (+ windows, uniquePermits)
  summaries.json         one HarvestWindowSummary per terminal window
  raw/<permitNumber>.html, raw/index.json   shared archive (sha256, fetchedAt per record)
  windows/<since>_<until>/…                  per terminal window, same files
```

`harvestWindow` alone writes the same files directly into `outDir`. The DuckDB
loader reads `data/raw/accela/<dir>/permits.jsonl` one level deep, i.e. the
merged file.

`skipExisting` (default on): when `raw/<permitNumber>.html` exists and its
sha256 equals `raw/index.json`, the record is re-emitted from the archive
(with the archived `fetchedAt`) and no request is made. Pass
`skipExisting: false` to force a re-fetch (status changes are only visible by
re-fetching, so refreshes of recent windows should do that).

## Known gaps / things the contract cannot represent

1. **No issued / finaled / closed dates.** They live in the lazy-loaded
   Processing Status / Inspections panels, which need the browser's JS
   callbacks. Options: a Playwright session per record (≈3× the cost), or
   accept `status` ("Issued", "Finaled", …) + the row date as the timeline.
2. **Temporary applications** (`OSCTEMP…`) cannot be `AccelaPermitRecord`s
   (no URL, no HTML) and are kept in `list-only.jsonl` only.
3. The grid "Date" column is labelled internally `lblUpdatedTime`; it behaves
   like the application date, but a record whose date changes can appear in
   two windows (deduplicated by record number, last fetch wins).
4. `normalizeParcelNumber` keeps letters (`3125290000015A0000` exists on the
   portal); the brief said "digits only" — change one line in `normalize.ts`
   if the join side really is numeric.
5. `undici` is imported for the pinned `Agent` but is only a transitive
   dependency of the workspace (hoisted 7.29.1); it should be declared in
   `packages/pipeline/package.json`.
6. Record type is a fixed dropdown value; other roofing-adjacent types
   (e.g. `Building/Permit/Solar/NA`) need separate searches.
