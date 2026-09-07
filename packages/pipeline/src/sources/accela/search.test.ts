import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPagerForm,
  buildSearchForm,
  capIdFromUrl,
  extractHiddenFields,
  isAjaxDelta,
  parseAjaxDelta,
  parseSearchResults,
  postbackTarget,
} from "./search.js";

const fixture = readFileSync(new URL("./__fixtures__/search-delta-page1.txt", import.meta.url), "utf8");

describe("parseAjaxDelta", () => {
  it("recognises the delta format", () => {
    expect(isAjaxDelta(fixture)).toBe(true);
    expect(isAjaxDelta("<html></html>")).toBe(false);
  });
  it("decodes panels and hidden fields", () => {
    const delta = parseAjaxDelta(fixture);
    expect([...delta.panels.keys()]).toEqual(["ctl00_PlaceHolderMain_updatePanel", "ctl00_PlaceHolderMain_updatePanel2"]);
    expect(delta.hiddenFields.get("__VIEWSTATE")).toHaveLength(266496);
    expect(delta.hiddenFields.get("__VIEWSTATEGENERATOR")).toBe("A9414CD7");
    expect(delta.hiddenFields.get("ACA_CS_FIELD")).toBe("ce0ed83ca9f54fd0b342137d4880b0ca");
    expect(delta.redirect).toBeNull();
    expect(delta.error).toBeNull();
  });
  it("decodes redirects and errors", () => {
    const seg = (type: string, id: string, content: string): string => `${content.length}|${type}|${id}|${content}|`;
    expect(parseAjaxDelta(`1|#||4|${seg("pageRedirect", "", "%2fCitizenAccess%2fError.aspx")}`).redirect).toBe("/CitizenAccess/Error.aspx");
    expect(parseAjaxDelta(`1|#||4|${seg("error", "500", "Server error")}`).error).toBe("500: Server error");
  });
});

describe("parseSearchResults", () => {
  const page = parseSearchResults(fixture);

  it("reads the caption, cap marker and pager", () => {
    expect(page.total).toBe(100);
    expect(page.capped).toBe(true);
    expect(page.showing).toEqual({ from: 1, to: 10 });
    expect(page.currentPage).toBe(1);
    expect(page.pageCount).toBe(11);
    expect(page.hasNextPage).toBe(true);
    expect(page.nextPageTarget).toBe("ctl00$PlaceHolderMain$dgvPermitList$gdvPermitList$ctl13$ctl03");
  });

  it("parses all ten rows, linked and list-only", () => {
    expect(page.rows).toHaveLength(10);
    const linked = page.rows.filter((r) => r.detailUrl);
    expect(linked).toHaveLength(7);
    const first = page.rows[1]!;
    expect(first).toMatchObject({
      permitNumber: "A26-006408",
      recordId: "REC26-00000-00U4X",
      capId: { capID1: "REC26", capID2: "00000", capID3: "00U4X" },
      detailUrl:
        "https://permits.osceola.org/CitizenAccess/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=REC26&capID2=00000&capID3=00U4X&agencyCode=OSCEOLA&IsToShowInspection=",
      date: "2026-09-04",
      recordType: "Roofing Permit",
      projectName: "<15K RES - Roofing Hickerson",
      address: "1500 JERSTAD, KISSIMMEE FL 34746",
      status: "Application Submitted",
      expirationDate: null,
    });
    expect(first.description).toMatch(/^Remove existing roofing materials/);
    expect(page.rows[3]!.status).toBe("Issued");
  });

  it("keeps temporary applications as list-only rows", () => {
    const temp = page.rows[0]!;
    expect(temp).toMatchObject({
      permitNumber: "OSCTEMP26-35056",
      recordId: "26EST-00000-35063",
      capId: null,
      detailUrl: null,
      date: "2026-09-05",
      status: null,
      address: "5129 SORRENTO BLVD, SAINT CLOUD FL 34771",
    });
  });

  it("handles an uncapped last page and an empty result", () => {
    const last = fixture.replace("Showing 1-10 of 100+", "Showing 91-97 of 97").replace(/<td class="aca_pagination_td[\s\S]*?<\/tr>/, "</tr>");
    const p = parseSearchResults(last);
    expect(p.total).toBe(97);
    expect(p.capped).toBe(false);
    expect(p.hasNextPage).toBe(false);
    const empty = parseSearchResults("<div><span>Your search returned no results.</span></div>");
    expect(empty.rows).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.capped).toBe(false);
  });
});

describe("forms", () => {
  it("builds the initial search postback from hidden fields", () => {
    const hidden = extractHiddenFields('<input type="hidden" name="__VIEWSTATE" value="abc" /><input type="hidden" name="__VIEWSTATEGENERATOR" value="A9414CD7" />');
    const form = buildSearchForm(hidden, { recordType: "Building/Permit/Roofing/NA", since: "2026-09-01", until: "2026-09-07" });
    expect(form.get("__VIEWSTATE")).toBe("abc");
    expect(form.get("ctl00$PlaceHolderMain$generalSearchForm$ddlGSPermitType")).toBe("Building/Permit/Roofing/NA");
    expect(form.get("ctl00$PlaceHolderMain$generalSearchForm$txtGSStartDate")).toBe("09/01/2026");
    expect(form.get("ctl00$PlaceHolderMain$generalSearchForm$txtGSEndDate")).toBe("09/07/2026");
    expect(form.get("ctl00$PlaceHolderMain$btnNewSearch")).toBe("Search");
    expect(form.get("__ASYNCPOST")).toBe("true");
  });
  it("carries the new viewstate into the pager postback", () => {
    const hidden = extractHiddenFields('<input type="hidden" name="__VIEWSTATE" value="old" />');
    const search = buildSearchForm(hidden, { recordType: "Building/Permit/Roofing/NA", since: "2026-09-01", until: "2026-09-07" });
    const delta = parseAjaxDelta(fixture);
    const pager = buildPagerForm(search, delta, "ctl00$PlaceHolderMain$dgvPermitList$gdvPermitList$ctl13$ctl03");
    expect(pager.get("__VIEWSTATE")).toHaveLength(266496);
    expect(pager.get("__EVENTTARGET")).toBe("ctl00$PlaceHolderMain$dgvPermitList$gdvPermitList$ctl13$ctl03");
    expect(pager.get("ctl00$ScriptManager1")).toBe("ctl00$PlaceHolderMain$dgvPermitList$updatePanel|ctl00$PlaceHolderMain$dgvPermitList$gdvPermitList$ctl13$ctl03");
    expect(pager.get("ctl00$PlaceHolderMain$dgvPermitList$lblNeedReBind")).toBe(""); // must stay untouched
    expect(pager.has("ctl00$PlaceHolderMain$btnNewSearch")).toBe(false);
    expect(pager.get("ctl00$PlaceHolderMain$generalSearchForm$txtGSStartDate")).toBe("09/01/2026");
  });
  it("parses postback targets and capIDs", () => {
    expect(postbackTarget("javascript:__doPostBack(&#39;a$b&#39;,&#39;&#39;)")).toBe("a$b");
    expect(postbackTarget("javascript:__doPostBack('a$b','Page$2')")).toBe("a$b");
    expect(postbackTarget(undefined)).toBeNull();
    expect(capIdFromUrl("/CitizenAccess/Cap/CapDetail.aspx?capID1=REC26&capID2=00000&capID3=00U4X")).toEqual({ capID1: "REC26", capID2: "00000", capID3: "00U4X" });
    expect(capIdFromUrl("/CitizenAccess/Cap/CapDetail.aspx?x=1")).toBeNull();
  });
});
