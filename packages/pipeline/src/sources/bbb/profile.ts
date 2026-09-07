/**
 * BBB business-profile parser.
 *
 * Reads `__PRELOADED_STATE__.businessProfile` (names, rating, accreditation,
 * reviews/complaints summary, contact, postal address, categories and the
 * `orgDetails.license.details[]` block that carries state license numbers)
 * and falls back to the schema.org `LocalBusiness` JSON-LD plus the `<h1>`
 * when the state is missing. Throws {@link ProfileParseError} when neither
 * yields a business name — that is what a challenge page or a 404 looks like.
 *
 * @module sources/bbb/profile
 */
import * as cheerio from "cheerio";
import type { BbbProfileRecord } from "@osceola/shared";
import { asArray, asBoolean, asInt, asObject, asString, extractPreloadedState, get } from "./preloaded-state.js";
import { bbbIdFromUrl, canonicalProfileUrl, extractLicenseNumbers, mergeLicenseNumbers, normalizePhone, normalizeRating, stripTags } from "./normalize.js";

/** Contract fields the parser produces; provenance (`fetchedAt`, `rawHtmlSha256`) is added by the harvester. */
export type ParsedProfileRecord = Omit<BbbProfileRecord, "fetchedAt" | "rawHtmlSha256">;

/** Useful fields the raw contract does not model — written to `profiles-extra.jsonl`. */
export interface ProfileExtras {
  primaryCategory: string | null;
  altNames: string[];
  website: string | null;
  additionalPhones: string[];
  outOfBusiness: boolean | null;
  /** Counties the business declares it serves (BBB "Service Area"). */
  servingCounties: string[];
  yearsInBusiness: number | null;
  businessStart: string | null;
  bbbFileOpened: string | null;
  accreditedSince: string | null;
  entityType: string | null;
  /** Complaints closed in the last 3 years / 12 months (the numbers BBB rates on). */
  complaintsClosedPast3Years: number | null;
  complaintsClosedPast12Months: number | null;
  averageReviewStars: number | null;
  ratingReasons: string[];
  alertCount: number;
  licenseAgencies: string[];
  licenseDetails: { licenseNumber: string | null; expirationDate: string | null; notes: string | null; agency: string | null }[];
  /** Where the fields came from: `state` (preloaded store) or `dom` (JSON-LD + markup fallback). */
  source: "state" | "dom";
}

/** {@link parseProfilePage} result: contract fields plus {@link ProfileExtras}. */
export interface ParsedProfile extends ParsedProfileRecord {
  extra: ProfileExtras;
}

/** The page is not a business profile (challenge interstitial, 404, layout change). */
export class ProfileParseError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "ProfileParseError";
  }
}

function jsonLdLocalBusiness(html: string): Record<string, unknown> | null {
  const $ = cheerio.load(html);
  let found: Record<string, unknown> | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return;
    try {
      const parsed = JSON.parse($(el).text()) as unknown;
      for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
        const o = asObject(node);
        if (o && (o["@type"] === "LocalBusiness" || o["@type"] === "Organization")) {
          found = o;
          return;
        }
      }
    } catch {
      /* not JSON */
    }
  });
  return found;
}

function fromState(bp: Record<string, unknown>, url: string): ParsedProfile {
  const bbbId =
    bbbIdFromUrl(url) ??
    (asString(bp.bbbId) && asString(bp.businessId) ? `${asString(bp.bbbId)}-${asString(bp.businessId)}` : null);
  const name = stripTags(asString(get(bp, ["names", "primary"])));
  if (!bbbId || !name) throw new ProfileParseError("businessProfile state without id/name", url);

  const postal = asObject(get(bp, ["location", "postalAddress"])) ?? asObject(get(bp, ["location", "displayAddress"])) ?? {};
  const line1 = asString(postal.addressLine1);
  const line2 = asString(postal.addressLine2);
  const address = [line1, line2].filter((s): s is string => s !== null).join(", ") || null;

  const licenseDetails = asArray(get(bp, ["orgDetails", "license", "details"])).map((d) => {
    const o = asObject(d) ?? {};
    return {
      licenseNumber: asString(o.licenseNumber),
      expirationDate: asString(o.expirationDate),
      notes: asString(o.notes),
      agency: asString(get(o, ["licenseAgency", "name"])),
    };
  });
  const licensingTexts = asArray(get(bp, ["orgDetails", "license", "licensingTexts"]))
    .map((t) => (typeof t === "string" ? t : asString(asObject(t)?.text)))
    .filter((t): t is string => t !== null);
  const licenseNumbers = mergeLicenseNumbers(
    licenseDetails.map((d) => d.licenseNumber),
    licenseDetails.flatMap((d) => extractLicenseNumbers(d.notes)),
    licensingTexts.flatMap((t) => extractLicenseNumbers(t)),
  );

  const categoryLinks = asArray(get(bp, ["categories", "links"]))
    .map((c) => stripTags(asString(asObject(c)?.title)))
    .filter((c): c is string => c !== null);
  const primaryCategory = stripTags(asString(get(bp, ["categories", "primaryCategoryName"])));
  const categories = [...new Set(categoryLinks.length > 0 ? categoryLinks : primaryCategory ? [primaryCategory] : [])];

  const servingCounties = asArray(get(bp, ["location", "servingAreas"])).flatMap((sa) =>
    asArray(asObject(sa)?.countyStates)
      .map((cs) => {
        const o = asObject(cs);
        const county = asString(o?.county);
        const st = asString(o?.stateCode);
        return county ? (st ? `${county}, ${st}` : county) : null;
      })
      .filter((c): c is string => c !== null),
  );

  const contact = asObject(bp.contactInformation) ?? {};
  const additionalPhones = asArray(contact.additionalPhoneNumbers)
    .map((p) => normalizePhone(asString(asObject(p)?.value)))
    .filter((p): p is string => p !== null);
  const phone = normalizePhone(asString(contact.phoneNumber)) ?? additionalPhones[0] ?? null;

  const summary = asObject(bp.reviewsComplaintsSummary) ?? {};
  const alerts = asObject(get(bp, ["display", "alerts"]));

  return {
    bbbId,
    name,
    rating: normalizeRating(asString(get(bp, ["rating", "bbbRating"]))),
    accredited: asBoolean(get(bp, ["accreditationInformation", "isAccredited"])),
    ratingScore: null, // the profile store carries no numeric score; the harvester overlays the listing's
    reviewCount: asInt(summary.reviewsTotal),
    complaintCount: asInt(summary.complaintsTotal),
    phone,
    address,
    city: asString(postal.city),
    state: asString(postal.stateCode),
    zip: asString(postal.zipCode),
    licenseNumbers,
    categories,
    profileUrl: canonicalProfileUrl(url),
    extra: {
      primaryCategory,
      altNames: asArray(get(bp, ["names", "altBusinessNames"]))
        .map((n) => stripTags(asString(n)))
        .filter((n): n is string => n !== null),
      website: asString(get(bp, ["urls", "primary"])),
      additionalPhones,
      outOfBusiness: asBoolean(get(bp, ["orgDetails", "isOutOfBusiness"])),
      servingCounties: [...new Set(servingCounties)],
      yearsInBusiness: asInt(get(bp, ["orgDetails", "yearsInBusiness"])),
      businessStart: asString(get(bp, ["dates", "businessStart"])),
      bbbFileOpened: asString(get(bp, ["dates", "bbbFileOpened"])),
      accreditedSince: asString(get(bp, ["dates", "accredited"])),
      entityType: asString(get(bp, ["orgDetails", "typeOfEntity", "name"])),
      complaintsClosedPast3Years: asInt(summary.totalClosedComplaintsPastThreeYears),
      complaintsClosedPast12Months: asInt(summary.totalClosedComplaintsPastTwelveMonths),
      averageReviewStars: typeof summary.averageOfReviewStarRatings === "number" ? summary.averageOfReviewStarRatings : null,
      ratingReasons: asArray(get(bp, ["rating", "ratingReasons"]))
        .map((r) => (typeof r === "string" ? r : asString(asObject(r)?.text)))
        .filter((r): r is string => r !== null),
      alertCount: alerts ? asArray(alerts.allIds).length : 0,
      licenseAgencies: [...new Set(licenseDetails.map((d) => d.agency).filter((a): a is string => a !== null))],
      licenseDetails,
      source: "state",
    },
  };
}

function fromDom(html: string, url: string): ParsedProfile {
  const bbbId = bbbIdFromUrl(url);
  const ld = jsonLdLocalBusiness(html) ?? {};
  const $ = cheerio.load(html);
  const name = stripTags(asString(ld.name)) ?? stripTags($("h1").first().text());
  if (!bbbId || !name) throw new ProfileParseError("no businessProfile state and no LocalBusiness name", url);
  const addr = asObject(ld.address) ?? {};
  const text = $("body").text();
  const ratingMatch = /BBB Rating:?\s*(A\+|A-|A|B\+|B-|B|C\+|C-|C|D\+|D-|D|F|NR)\b/i.exec(text);
  const licenseSection = /Licens(?:e|ing)[\s\S]{0,600}/i.exec(text)?.[0] ?? "";
  return {
    bbbId,
    name,
    rating: normalizeRating(ratingMatch?.[1] ?? null),
    accredited: /BBB Accredited Business/i.test(text) ? true : null,
    ratingScore: null,
    reviewCount: null,
    complaintCount: null,
    phone: normalizePhone(asString(ld.telephone)),
    address: asString(addr.streetAddress),
    city: asString(addr.addressLocality),
    state: asString(addr.addressRegion),
    zip: asString(addr.postalCode),
    licenseNumbers: extractLicenseNumbers(licenseSection),
    categories: [],
    profileUrl: canonicalProfileUrl(url),
    extra: {
      primaryCategory: null,
      altNames: [],
      website: null,
      additionalPhones: [],
      outOfBusiness: null,
      servingCounties: [],
      yearsInBusiness: null,
      businessStart: asString(ld.foundingDate),
      bbbFileOpened: null,
      accreditedSince: null,
      entityType: null,
      complaintsClosedPast3Years: null,
      complaintsClosedPast12Months: null,
      averageReviewStars: null,
      ratingReasons: [],
      alertCount: 0,
      licenseAgencies: [],
      licenseDetails: [],
      source: "dom",
    },
  };
}

/**
 * Parse a BBB business profile page.
 *
 * @param html - full page HTML as served (or as serialised by the browser)
 * @param url  - the URL the page was fetched from; the business id is taken from it
 * @throws {ProfileParseError} when the page is not a business profile
 */
export function parseProfilePage(html: string, url: string): ParsedProfile {
  const bp = asObject(get(extractPreloadedState(html), ["businessProfile"]));
  if (bp && asString(get(bp, ["names", "primary"]))) return fromState(bp, url);
  return fromDom(html, url);
}
