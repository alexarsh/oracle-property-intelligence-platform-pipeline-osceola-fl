/**
 * Parser for `CapDetail.aspx` pages.
 *
 * Layout notes (Osceola, ACA 21.x "new ui"):
 * - Header: `#ctl00_PlaceHolderMain_lblPermitNumber`, `…_lblPermitType`,
 *   `…_lblRecordStatus`.
 * - "Record Details" is a two-column table of `td.td_parent_left` blocks,
 *   each with an `<h1><span>Label:</span></h1>` and a nested
 *   `table.table_child` whose last `<td>` holds `<br/>`-separated lines. The
 *   "Licensed Professional" block embeds another table for phone numbers.
 * - "More Details" (collapsed by CSS, but present in the HTML) holds
 *   "Application Information" as `div.MoreDetail_ItemColASI` label/value
 *   pairs (Construction Value, Reroof, Manufacturer, …) and "Parcel
 *   Information" as an `<h2>` label followed by a value div.
 * - Fees, Inspections, Processing Status and Related Records are loaded by
 *   the browser after page load; the initial HTML only says "Loading...".
 *   The Processing Status async postback returns no panel either, so
 *   issued / finaled / closed dates are NOT available from this page.
 * - There is no "Work Location" block on this portal (only the HTML comment);
 *   the job-site address comes from the search result row.
 *
 * Extraction is label-based wherever the markup allows it so column
 * re-ordering or extra fields do not break the parser.
 *
 * @module sources/accela/detail
 */
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { cleanText, labelKey, parseMoney, toIsoDate } from "./normalize.js";
import { capIdFromUrl } from "./search.js";
import type { ParsedCapDetail, PermitDetail } from "./types.js";

/** Raised when a page does not look like a record detail (missing header). Treated as permanent. */
export class DetailParseError extends Error {
  override readonly name = "DetailParseError";
}

type Sel = ReturnType<CheerioAPI>;

/** Turn an HTML fragment into trimmed text lines, splitting on `<br>` and block boundaries. */
function linesOf($: CheerioAPI, el: Sel): string[] {
  const clone = el.clone();
  clone.find("br").replaceWith("\n");
  clone.find("table, tr, div, p, h1, h2").each((_, node) => {
    $(node).prepend("\n").append("\n");
  });
  return clone
    .text()
    .split("\n")
    .map((l) => cleanText(l))
    .filter((l): l is string => l !== null);
}

/** Find the value cell of a "Record Details" block by its label text. */
function recordDetailBlock($: CheerioAPI, label: RegExp): Sel | null {
  let found: Sel | null = null;
  $("td.td_parent_left").each((_, td) => {
    if (found) return;
    const heading = cleanText($(td).find("h1 span").first().text()) ?? "";
    if (label.test(heading)) {
      // The value cell is the last <td> of the block's OWN table; nested tables (phone numbers)
      // must not win, so filter by the closest enclosing table.
      const table = $(td).find("table.table_child").first();
      const cell = table.find("td").filter((__, c) => $(c).closest("table")[0] === table[0]).last();
      if (cell.length) found = cell;
    }
  });
  return found;
}

/** Collect label → value pairs from "More Details" (ASI groups and parcel list). */
function moreDetails($: CheerioAPI): Record<string, string> {
  const out: Record<string, string> = {};
  $("div.MoreDetail_ItemCol1").each((_, div) => {
    const $div = $(div);
    const label = labelKey($div.find("span, h2").first().text());
    if (!label) return;
    const valueEl = $div.next(".MoreDetail_ItemCol2");
    const value = valueEl.length ? cleanText(valueEl.text()) : cleanText($div.children("div").first().text());
    if (value !== null && !(label in out)) out[label] = value;
  });
  return out;
}

const LICENSE_LINE = /^(.*?)\s*\b([A-Z]{1,5}[- ]?\d{4,10})$/;
const CITY_LINE = /,\s*[A-Z]{2},?\s*\d{5}(?:-\d{4})?$/;
const EMAIL = /\S+@\S+\.\S+/;

/**
 * Parse the "Licensed Professional" block, which is free text of the form:
 * ```
 * NAME [email]
 * BUSINESS NAME
 * STREET
 * CITY, ST, ZIP
 * [Home Phone: 5551234567]
 * LICENSE TYPE LICENSENUMBER
 * ```
 * Every line is optional except the first, so the parser anchors on the
 * shapes it can recognise (license suffix, `CITY, ST, ZIP`, digits-first
 * street) and treats what is left between name and street as the business.
 */
export function parseLicensedProfessional(
  $: CheerioAPI,
  cell: Sel,
): { contractor: NonNullable<PermitDetail["contractor"]>; extra: Record<string, string> } {
  const extra: Record<string, string> = {};
  const work = cell.clone();
  // Phone rows live in a nested table: "Home Phone:" | <div class=ACA_PhoneNumberLTR>…</div>
  const phones: string[] = [];
  work.find("table").each((_, table) => {
    $(table)
      .find("tr")
      .each((__, tr) => {
        const tds = $(tr).find("td");
        const label = labelKey(tds.first().text());
        const value = cleanText(tds.last().text());
        if (label && value) {
          extra[`contractor.${label}`] = value;
          phones.push(value);
        }
      });
    $(table).remove();
  });

  const lines = linesOf($, work);
  let licenseType: string | null = null;
  let licenseNumber: string | null = null;
  let licenseIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = LICENSE_LINE.exec(lines[i]!);
    if (m && !CITY_LINE.test(lines[i]!)) {
      licenseType = cleanText(m[1]);
      licenseNumber = m[2]!.replace(/[- ]/g, "");
      licenseIdx = i;
      break;
    }
  }
  const body = licenseIdx >= 0 ? lines.filter((_, i) => i !== licenseIdx) : lines;

  const first = body[0] ?? "";
  const email = EMAIL.exec(first)?.[0] ?? null;
  if (email) extra["contractor.email"] = email;
  const name = cleanText(email ? first.replace(email, "") : first);

  const middle = body.slice(1);
  let cityIdx = -1;
  for (let i = middle.length - 1; i >= 0; i--) if (CITY_LINE.test(middle[i]!)) { cityIdx = i; break; }
  let businessName: string | null = null;
  let address: string | null = null;
  if (cityIdx >= 0) {
    // The street is the last digit- or PO-Box-led line before the city line; anything between it
    // and the city line (suite, building, "GAI BUILDING") is still address, anything before is business.
    let streetStart = cityIdx;
    for (let i = cityIdx - 1; i >= 0; i--) {
      if (/^(\d|P\.?O\.? ?BOX)/i.test(middle[i]!)) {
        streetStart = i;
        break;
      }
    }
    businessName = cleanText(middle.slice(0, streetStart).join(" "));
    address = cleanText(middle.slice(streetStart, cityIdx + 1).join(", "));
  } else {
    businessName = middle[0] ?? null;
    address = cleanText(middle.slice(1).join(", "));
  }

  return {
    contractor: { name, businessName, licenseNumber, licenseType, phone: phones[0] ?? null, address },
    extra,
  };
}

const DATE_LABELS: ReadonlyArray<[keyof PermitDetail & `${string}Date`, RegExp]> = [
  ["openedDate", /^(application|applied|open(ed)?|file[d]?) date$/i],
  ["issuedDate", /^issued?( date)?$/i],
  ["expirationDate", /^(expir(ation|es|e|y)( date)?)$/i],
  ["finaledDate", /^(final(ed|ized)?|certificate of (occupancy|completion)|co)( date)?$/i],
  ["closedDate", /^closed?( date)?$/i],
];

/**
 * Parse a detail page into the contract fields plus all unmapped label/value
 * pairs. Throws {@link DetailParseError} when the record header is missing
 * (error page, expired session, unknown record).
 */
export function parseCapDetailExtended(html: string, url: string): ParsedCapDetail {
  const $ = cheerio.load(html);
  const permitNumber = cleanText($("#ctl00_PlaceHolderMain_lblPermitNumber").text());
  if (!permitNumber) throw new DetailParseError("detail page has no record number header");
  const capId = capIdFromUrl(url);
  if (!capId) throw new DetailParseError(`detail URL has no capID triple: ${url}`);

  const extra = moreDetails($);
  const descriptionCell = recordDetailBlock($, /^project description/i);
  const description = descriptionCell ? cleanText(linesOf($, descriptionCell).join(" ")) : null;

  let contractor: PermitDetail["contractor"] = null;
  const licenseCell = recordDetailBlock($, /^licensed professional/i);
  if (licenseCell) {
    const parsed = parseLicensedProfessional($, licenseCell);
    Object.assign(extra, parsed.extra);
    const c = parsed.contractor;
    if (Object.values(c).some((v) => v !== null)) contractor = c;
  }

  const lookup = (re: RegExp): string | null => {
    for (const [k, v] of Object.entries(extra)) if (re.test(k)) return v;
    return null;
  };
  const dates: Partial<Record<(typeof DATE_LABELS)[number][0], string | null>> = {};
  for (const [field, re] of DATE_LABELS) dates[field] = toIsoDate(lookup(re));

  const record: PermitDetail = {
    permitNumber,
    capId,
    recordType: cleanText($("#ctl00_PlaceHolderMain_lblPermitType").text()),
    status: cleanText($("#ctl00_PlaceHolderMain_lblRecordStatus").text()),
    openedDate: dates.openedDate ?? null,
    issuedDate: dates.issuedDate ?? null,
    expirationDate: dates.expirationDate ?? null,
    finaledDate: dates.finaledDate ?? null,
    closedDate: dates.closedDate ?? null,
    description,
    jobValue: parseMoney(lookup(/^(construction value|job value|valuation|estimated (job|construction) value|total valuation)$/i)),
    parcelNumber: lookup(/^parcel (number|no\.?|id)$/i),
    address: lookup(/^(work location|job (site )?address|site address|property address)$/i),
    contractor,
    sourceUrl: url,
  };
  return { record, extra };
}

/** Contract-shaped view of {@link parseCapDetailExtended}. */
export function parseCapDetail(html: string, url: string): PermitDetail {
  return parseCapDetailExtended(html, url).record;
}
