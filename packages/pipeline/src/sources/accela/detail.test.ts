import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AccelaPermitRecord } from "@osceola/shared";
import { DetailParseError, parseCapDetail, parseCapDetailExtended } from "./detail.js";

const issuedUrl =
  "https://permits.osceola.org/CitizenAccess/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=REC26&capID2=00000&capID3=00U45&agencyCode=OSCEOLA&IsToShowInspection=";
const submittedUrl =
  "https://permits.osceola.org/CitizenAccess/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=REC26&capID2=00000&capID3=00U4X&agencyCode=OSCEOLA&IsToShowInspection=";
const issued = readFileSync(new URL("./__fixtures__/cap-detail-roofing.html", import.meta.url), "utf8");
const submitted = readFileSync(new URL("./__fixtures__/cap-detail-roofing-submitted.html", import.meta.url), "utf8");

describe("parseCapDetail (issued roofing permit)", () => {
  const record = parseCapDetail(issued, issuedUrl);

  it("reads the header", () => {
    expect(record.permitNumber).toBe("A26-006405");
    expect(record.recordType).toBe("Roofing Permit");
    expect(record.status).toBe("Issued");
    expect(record.capId).toEqual({ capID1: "REC26", capID2: "00000", capID3: "00U45" });
    expect(record.sourceUrl).toBe(issuedUrl);
  });

  it("reads the licensed professional block", () => {
    expect(record.contractor).toEqual({
      name: "KEITH BATTERBEE",
      businessName: "BATTERBEE ROOFING, INC",
      licenseNumber: "CCC1326176",
      licenseType: "ROOFING CONTRACTOR",
      phone: "3527486300",
      address: "4049 NE 120TH XING, OXFORD, FL, 34484",
    });
  });

  it("reads description, valuation and parcel from More Details", () => {
    expect(record.description).toBe("RES - Roofing Katisha Grant Tear off and replace asphalt shingles on SFR REROOF Manufacturer: Owens Corning, FL# or NOA# 10674.1");
    expect(record.jobValue).toBe(22599);
    expect(record.parcelNumber).toBe("252628610005220080");
  });

  it("leaves fields the page does not show as null", () => {
    expect(record.address).toBeNull();
    expect(record.openedDate).toBeNull();
    expect(record.issuedDate).toBeNull();
    expect(record.expirationDate).toBeNull();
    expect(record.finaledDate).toBeNull();
    expect(record.closedDate).toBeNull();
  });

  it("produces a contract-valid record once provenance is added", () => {
    const full = AccelaPermitRecord.parse({
      ...record,
      fetchedAt: new Date().toISOString(),
      rawHtmlSha256: "a".repeat(64),
      rawHtmlPath: "raw/A26-006405.html",
    });
    expect(full.permitNumber).toBe("A26-006405");
  });
});

describe("parseCapDetailExtended (submitted application)", () => {
  const { record, extra } = parseCapDetailExtended(submitted, submittedUrl);

  it("reads a different record and status", () => {
    expect(record.permitNumber).toBe("A26-006408");
    expect(record.status).toBe("Application Submitted");
    expect(record.jobValue).toBe(12500);
    expect(record.parcelNumber).toBe("3125290000015A0000");
    expect(record.contractor).toMatchObject({
      name: "LEONARDO JR ABALLE",
      businessName: "RHINO ROOFING ORLANDO LLC",
      licenseNumber: "CCC1336971",
      licenseType: "ROOFING CONTRACTOR",
      address: "385 Commerce Way Suite 101, Longwood, FL, 32750",
    });
  });

  it("keeps unmapped application information", () => {
    expect(extra["Reroof"]).toBe("Yes");
    expect(extra["Hurricane Related"]).toBe("No");
    expect(extra["Manufacturer"]).toBe("Atlas");
    expect(extra["FL# or NOA#"]).toBe("FL21350-R5");
    expect(extra["Permit for:"]).toBe("Residential");
    expect(extra["contractor.email"]).toBe("chase@roof407.com");
  });
});

describe("parseLicensedProfessional shapes", () => {
  const block = (inner: string): string =>
    `<table><tr><td class="td_parent_left"><div><h1><span>Licensed Professional:</span></h1><span><table class="table_child"><tr><td class="td_child_left"></td><td>${inner}</td></tr></table></span></div></td></tr></table><span id="ctl00_PlaceHolderMain_lblPermitNumber">X26-1</span>`;
  const url = "https://permits.osceola.org/CitizenAccess/Cap/CapDetail.aspx?capID1=A&capID2=B&capID3=C";

  it("keeps suite / building lines with the street", () => {
    const html = block(
      "DAVID A TORRES David@TopBuilderRoofing.com <br/> TOP BUILDER ROOFING LLC<br/> 618 EAST SOUTH STREET<br/> GAI BUILDING<br/> ORLANDO, FL, 32801<br/> <table><tr><td>Mobile Phone:</td><td><div class=\"ACA_PhoneNumberLTR\">7184516222</div></td></tr></table>ROOFING CONTRACTOR CCC1333344<br/>",
    );
    expect(parseCapDetail(html, url).contractor).toEqual({
      name: "DAVID A TORRES",
      businessName: "TOP BUILDER ROOFING LLC",
      licenseNumber: "CCC1333344",
      licenseType: "ROOFING CONTRACTOR",
      phone: "7184516222",
      address: "618 EAST SOUTH STREET, GAI BUILDING, ORLANDO, FL, 32801",
    });
  });

  it("handles an owner-builder without business or license", () => {
    const html = block("JANE DOE<br/> 123 MAIN ST<br/> KISSIMMEE, FL, 34746<br/>");
    expect(parseCapDetail(html, url).contractor).toEqual({
      name: "JANE DOE",
      businessName: null,
      licenseNumber: null,
      licenseType: null,
      phone: null,
      address: "123 MAIN ST, KISSIMMEE, FL, 34746",
    });
  });
});

describe("error handling", () => {
  it("rejects pages without a record header", () => {
    expect(() => parseCapDetail("<html><body>Session expired</body></html>", issuedUrl)).toThrow(DetailParseError);
  });
  it("rejects URLs without a capID triple", () => {
    expect(() => parseCapDetail(issued, "https://permits.osceola.org/CitizenAccess/Cap/CapDetail.aspx")).toThrow(DetailParseError);
  });
});
