import { describe, expect, it } from "vitest";
import {
  bbbIdFromUrl,
  canonicalProfileUrl,
  extractLicenseNumbers,
  mergeLicenseNumbers,
  normalizeLicense,
  normalizePhone,
  normalizeRating,
  parseBbbId,
  slugToTitle,
  stripTags,
} from "./normalize.js";

describe("parseBbbId / bbbIdFromUrl", () => {
  it("reads bureau + business id from a canonical profile URL", () => {
    expect(parseBbbId("https://www.bbb.org/us/fl/kissimmee/profile/roofing-contractors/greenway-roofing-of-florida-0733-90573947")).toEqual({
      bbbId: "0733-90573947",
      bureauId: "0733",
      businessId: "90573947",
    });
  });
  it("handles relative URLs, addressId variants and sub-pages", () => {
    expect(bbbIdFromUrl("/us/fl/kissimmee/profile/roofing-contractors/affordable-roofing-by-john-cadwell-inc-0733-22003102/addressId/19016")).toBe("0733-22003102");
    expect(bbbIdFromUrl("/us/fl/orlando/profile/roofing-contractors/fiddlers-roofing-0733-90639740/customer-reviews")).toBe("0733-90639740");
    expect(bbbIdFromUrl("/us/tn/goodlettsville/profile/roofing-contractors/best-choice-roofing-home-improvement-inc-0573-37045769?x=1")).toBe("0573-37045769");
  });
  it("is not fooled by digits inside the slug", () => {
    expect(bbbIdFromUrl("/us/fl/orlando/profile/roofing-contractors/a-1-roofing-24-7-llc-0733-235962076")).toBe("0733-235962076");
  });
  it("returns null for non-profile URLs", () => {
    expect(bbbIdFromUrl("/us/fl/kissimmee/category/roofing-contractors?page=2")).toBeNull();
    expect(bbbIdFromUrl("/us/fl/kissimmee/profile/roofing-contractors/no-id-here")).toBeNull();
  });
});

describe("canonicalProfileUrl", () => {
  it("resolves against bbb.org and strips query/fragment/trailing slash", () => {
    expect(canonicalProfileUrl("/us/fl/kissimmee/profile/roofing-contractors/x-0733-1/?utm=1#reviews")).toBe(
      "https://www.bbb.org/us/fl/kissimmee/profile/roofing-contractors/x-0733-1",
    );
  });
});

describe("normalizePhone", () => {
  it("keeps ten digits and strips a leading country code", () => {
    expect(normalizePhone("(407) 230-3723")).toBe("4072303723");
    expect(normalizePhone("+1 407.230.3723")).toBe("4072303723");
    expect(normalizePhone("1-407-230-3723")).toBe("4072303723");
  });
  it("rejects short, long and empty values", () => {
    expect(normalizePhone("230-3723")).toBeNull();
    expect(normalizePhone("407230372345")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe("license normalisation", () => {
  it("normalises separators, case and labels", () => {
    expect(normalizeLicense("ccc1330217")).toBe("CCC1330217");
    expect(normalizeLicense("CCC 1330-217")).toBe("CCC1330217");
    expect(normalizeLicense("License # CGC1512345")).toBe("CGC1512345");
    expect(normalizeLicense("#RC29027456")).toBe("RC29027456");
  });
  it("rejects values without digits or of implausible length", () => {
    expect(normalizeLicense("N/A")).toBeNull();
    expect(normalizeLicense("None")).toBeNull();
    expect(normalizeLicense("")).toBeNull();
    expect(normalizeLicense("1")).toBeNull();
  });
  it("extracts Florida DBPR codes from free text and de-duplicates", () => {
    expect(extractLicenseNumbers("State license CCC1330217; also holds CGC 1512345 and CCC-1330217. Phone 407-230-3723.")).toEqual(["CCC1330217", "CGC1512345"]);
    expect(extractLicenseNumbers(null)).toEqual([]);
  });
  it("merges lists in order without duplicates or nulls", () => {
    expect(mergeLicenseNumbers(["CCC1331395", null], ["ccc1331395", "EC13001234"])).toEqual(["CCC1331395", "EC13001234"]);
  });
});

describe("normalizeRating", () => {
  it("accepts the 13 BBB letter grades", () => {
    for (const g of ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F"]) expect(normalizeRating(g)).toBe(g);
    expect(normalizeRating(" a+ ")).toBe("A+");
  });
  it("maps NR and junk to null", () => {
    expect(normalizeRating("NR")).toBeNull();
    expect(normalizeRating("Not Rated")).toBeNull();
    expect(normalizeRating(null)).toBeNull();
  });
});

describe("stripTags / slugToTitle", () => {
  it("removes search highlight markup and decodes entities", () => {
    expect(stripTags("Nelson Arburola <em>Contractor</em> Quality <em>Roofing</em>")).toBe("Nelson Arburola Contractor Quality Roofing");
    expect(stripTags("A &amp; B Roofing")).toBe("A & B Roofing");
    expect(stripTags("   ")).toBeNull();
  });
  it("title-cases slugs", () => {
    expect(slugToTitle("saint-cloud")).toBe("Saint Cloud");
    expect(slugToTitle("roofing-contractors")).toBe("Roofing Contractors");
  });
});
