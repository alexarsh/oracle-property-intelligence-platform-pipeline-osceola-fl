import { readFileSync } from "node:fs";
import { BbbProfileRecord } from "@osceola/shared";
import { describe, expect, it } from "vitest";
import { ProfileParseError, parseProfilePage } from "./profile.js";

const fixtures = new URL("./__fixtures__/", import.meta.url);
const greenwayUrl = "https://www.bbb.org/us/fl/kissimmee/profile/roofing-contractors/greenway-roofing-of-florida-0733-90573947";
const cadwellUrl = "https://www.bbb.org/us/fl/kissimmee/profile/roofing-contractors/affordable-roofing-by-john-cadwell-inc-0733-22003102/addressId/19016";
const greenway = readFileSync(new URL("profile-greenway-roofing.html", fixtures), "utf8");
const cadwell = readFileSync(new URL("profile-affordable-roofing-cadwell.html", fixtures), "utf8");

describe("parseProfilePage (Greenway Roofing of Florida)", () => {
  const p = parseProfilePage(greenway, greenwayUrl);

  it("reads identity, rating and accreditation", () => {
    expect(p.bbbId).toBe("0733-90573947");
    expect(p.name).toBe("Greenway Roofing of Florida");
    expect(p.rating).toBe("A+");
    expect(p.accredited).toBe(true);
    expect(p.ratingScore).toBeNull();
    expect(p.profileUrl).toBe(greenwayUrl);
  });

  it("reads reviews, complaints, phone and address", () => {
    expect(p.reviewCount).toBe(1);
    expect(p.complaintCount).toBe(0);
    expect(p.phone).toBe("4072303723");
    expect(p.address).toBe("16 N Orlando Ave");
    expect(p.city).toBe("Kissimmee");
    expect(p.state).toBe("FL");
    expect(p.zip).toBe("34741-5135");
  });

  it("captures the state license number and categories", () => {
    expect(p.licenseNumbers).toEqual(["CCC1331395"]);
    expect(p.categories).toContain("Roofing Contractors");
    expect(p.categories).toContain("Residential Roofing");
    expect(p.categories.length).toBe(10);
  });

  it("keeps useful extras", () => {
    expect(p.extra.source).toBe("state");
    expect(p.extra.servingCounties).toContain("Osceola, FL");
    expect(p.extra.licenseAgencies).toEqual(["Florida Department of Business & Professional Regulation"]);
    expect(p.extra.website).toBe("https://www.greenwayroofing.com");
    expect(p.extra.altNames).toEqual(["Greenway of Florida Inc"]);
    expect(p.extra.additionalPhones).toEqual(["4072303858"]);
    expect(p.extra.entityType).toBe("Corporation");
    expect(p.extra.outOfBusiness).toBe(false);
  });

  it("produces a contract-valid record once provenance is added", () => {
    const { extra: _extra, ...fields } = p;
    const full = BbbProfileRecord.parse({ ...fields, fetchedAt: new Date().toISOString(), rawHtmlSha256: "a".repeat(64) });
    expect(full.bbbId).toBe("0733-90573947");
    expect(Object.keys(full).sort()).toEqual(
      ["accredited", "address", "bbbId", "categories", "city", "complaintCount", "fetchedAt", "licenseNumbers", "name", "phone", "profileUrl", "rating", "ratingScore", "rawHtmlSha256", "reviewCount", "state", "zip"].sort(),
    );
  });
});

describe("parseProfilePage (Affordable Roofing By John Cadwell, addressId variant)", () => {
  const p = parseProfilePage(cadwell, cadwellUrl);
  it("takes the id from the URL even with an /addressId suffix", () => {
    expect(p.bbbId).toBe("0733-22003102");
    expect(p.name).toBe("Affordable Roofing By John Cadwell, Inc.");
    expect(p.profileUrl).toBe(cadwellUrl);
  });
  it("reads its fields", () => {
    expect(p.rating).toBe("A+");
    expect(p.accredited).toBe(true);
    expect(p.reviewCount).toBe(0);
    expect(p.complaintCount).toBe(0);
    expect(p.phone).toBe("4079350050");
    expect(p.address).toBe("600 N Thacker Ave Ste W2");
    expect(p.zip).toBe("34741-4802");
    expect(p.licenseNumbers).toEqual(["CCC1326887"]);
    expect(p.categories).toEqual(["Roofing Contractors", "Metal Roofing Contractors", "Soffit and Fascia", "Roofing Consultants", "Tile Roofing Contractors", "Shingles"]);
    expect(p.extra.servingCounties).toEqual(["Brevard, FL"]);
  });
});

describe("parseProfilePage fallbacks", () => {
  it("uses JSON-LD + h1 when the preloaded state is missing", () => {
    const stripped = greenway.replace("window.__PRELOADED_STATE__", "window.__NOPE__");
    const p = parseProfilePage(stripped, greenwayUrl);
    expect(p.extra.source).toBe("dom");
    expect(p.name).toBe("Greenway Roofing of Florida");
    expect(p.phone).toBe("4072303723");
    expect(p.address).toBe("16 N Orlando Ave");
    expect(p.zip).toBe("34741-5135");
    expect(p.bbbId).toBe("0733-90573947");
  });
  it("throws ProfileParseError for a challenge page", () => {
    const challenge = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></body></html>';
    expect(() => parseProfilePage(challenge, greenwayUrl)).toThrow(ProfileParseError);
  });
});
