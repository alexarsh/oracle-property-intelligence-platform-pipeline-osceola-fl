import { describe, expect, it } from "vitest";
import {
  assertReadOnlySelect,
  buildPermitsByParcelSql,
  buildPermitsForParcelsSql,
  buildPropertyByParcelSql,
  buildRadiusPermitsSql,
  buildRadiusPropertiesCountSql,
  buildRadiusPropertiesSql,
  column,
  haversineSql,
  likeTerm,
  limitOf,
  safeId,
} from "./sql";

describe("haversineSql", () => {
  it("emits the miles haversine with both coordinates parenthesized", () => {
    const sql = haversineSql(28.2919, -81.4076);
    expect(sql).toContain("3958.8*2*asin(");
    expect(sql).toContain("radians(latitude-(28.2919))");
    expect(sql).toContain("radians(longitude-(-81.4076))");
  });
  it("rejects non-finite coordinates", () => {
    expect(() => haversineSql(Number.NaN, 0)).toThrow(/finite/);
    expect(() => haversineSql(0, Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe("guards", () => {
  it("whitelists columns per table", () => {
    expect(column("roof_age_years", "properties")).toBe("roof_age_years");
    expect(column("days_open", "permits")).toBe("days_open");
    expect(() => column("days_open", "properties")).toThrow(/unknown properties column/);
    expect(() => column("x; DROP TABLE", "permits")).toThrow();
  });
  it("safeId accepts parcel ids and rejects quotes", () => {
    expect(safeId("222529156900010010")).toBe("'222529156900010010'");
    expect(safeId("2225291050000E0040")).toBe("'2225291050000E0040'");
    expect(() => safeId("1' OR '1'='1")).toThrow(/unsupported/);
    expect(() => safeId("")).toThrow();
  });
  it("likeTerm escapes quotes and wildcards", () => {
    expect(likeTerm("O'NEIL 100%_x")).toBe(`'%O''NEIL 100\\%\\_x%' ESCAPE '\\'`);
    expect(likeTerm("a\\b")).toBe(`'%a\\\\b%' ESCAPE '\\'`);
  });
  it("limitOf clamps", () => {
    expect(limitOf(undefined, 500)).toBe(500);
    expect(limitOf(5000, 500)).toBe(1000);
    expect(limitOf(-3, 500)).toBe(500);
    expect(limitOf(7.9, 500)).toBe(7);
  });
});

describe("buildRadiusPropertiesSql", () => {
  const base = { lat: 28.2919, lng: -81.4076, radiusMiles: 5 };
  it("builds a single SELECT with bbox pre-filter, distance and limit", () => {
    const sql = buildRadiusPropertiesSql({ ...base, minRoofAgeYears: 15 });
    expect(sql.startsWith("SELECT * FROM (SELECT ")).toBe(true);
    expect(sql).toContain("latitude BETWEEN");
    expect(sql).toContain("roof_age_years >= 15");
    expect(sql).toContain("WHERE distance_miles <= 5");
    expect(sql).toContain("ORDER BY roof_age_years DESC NULLS LAST, distance_miles ASC LIMIT 500");
    expect(sql.split(";").length).toBe(1);
  });
  it("adds every optional filter", () => {
    const sql = buildRadiusPropertiesSql({
      ...base,
      openRoofPermits: true,
      openRoofPermitMinYears: 5,
      ownerOutOfState: true,
      minYearsSinceSale: 10,
      propertyTypes: ["residential", "commercial"],
      ownerContains: "SMITH",
      limit: 50,
    });
    expect(sql).toContain("open_roof_permit_count > 0");
    expect(sql).toContain("oldest_open_roof_permit_days >= 1826");
    expect(sql).toContain("owner_out_of_state = true");
    expect(sql).toContain("years_since_sale >= 10");
    expect(sql).toContain("property_type IN ('residential', 'commercial')");
    expect(sql).toContain("owners_text ILIKE '%SMITH%' ESCAPE '\\'");
    expect(sql).toMatch(/LIMIT 50$/);
  });
  it("never interpolates raw user text", () => {
    const sql = buildRadiusPropertiesSql({ ...base, ownerContains: "x' OR 1=1 --" });
    expect(sql).not.toContain("'x' OR 1=1");
    expect(sql).toContain("'%x'' OR 1=1 --%'");
    expect((sql.match(/'/g) ?? []).length % 2).toBe(0);
  });
  it("restricts to validated parcel ids when given", () => {
    const sql = buildRadiusPropertiesSql({
      ...base,
      parcelIdentifiers: ["1", "2225291050000E0040"],
    });
    expect(sql).toContain("parcel_identifier IN ('1', '2225291050000E0040')");
    expect(() => buildRadiusPropertiesSql({ ...base, parcelIdentifiers: [] })).toThrow(/1\.\.1000/);
    expect(() => buildRadiusPropertiesSql({ ...base, parcelIdentifiers: ["x'y"] })).toThrow(
      /unsupported/,
    );
  });
  it("count query reuses the list query's WHERE clause", () => {
    const sql = buildRadiusPropertiesCountSql({
      ...base,
      minRoofAgeYears: 15,
      ownerOutOfState: true,
    });
    expect(
      sql.startsWith("SELECT count(*) AS total FROM properties WHERE latitude IS NOT NULL"),
    ).toBe(true);
    expect(sql).toContain("roof_age_years >= 15 AND owner_out_of_state = true");
    expect(sql).toMatch(/<= 5$/);
    expect(sql).not.toContain("LIMIT");
  });
  it("rejects bad radius and unknown property types", () => {
    expect(() => buildRadiusPropertiesSql({ ...base, radiusMiles: 0 })).toThrow(/radiusMiles/);
    expect(() => buildRadiusPropertiesSql({ ...base, radiusMiles: 99 })).toThrow(/radiusMiles/);
    // @ts-expect-error runtime guard for untyped callers
    expect(() => buildRadiusPropertiesSql({ ...base, propertyTypes: ["'; DROP"] })).toThrow(
      /unknown property type/,
    );
  });
});

describe("buildRadiusPermitsSql", () => {
  it("defaults to open roofing permits ordered by days_open", () => {
    const sql = buildRadiusPermitsSql({ lat: 28.29, lng: -81.4, radiusMiles: 3 });
    expect(sql).toContain("is_roofing = true");
    expect(sql).toContain("is_open = true");
    expect(sql).toContain("ORDER BY days_open DESC NULLS LAST");
    expect(sql).toMatch(/LIMIT 200$/);
  });
  it("honours minDaysOpen and requireContractor", () => {
    const sql = buildRadiusPermitsSql({
      lat: 28.29,
      lng: -81.4,
      radiusMiles: 3,
      minDaysOpen: 1825.7,
      requireContractor: true,
      roofingOnly: false,
      openOnly: false,
    });
    expect(sql).toContain("days_open >= 1825");
    expect(sql).toContain("contractor_name IS NOT NULL");
    expect(sql).not.toContain("is_roofing = true");
  });
});

describe("parcel queries", () => {
  it("builds property and permit lookups by validated parcel id", () => {
    expect(buildPropertyByParcelSql("222529156900010010")).toBe(
      "SELECT * FROM properties WHERE parcel_identifier = '222529156900010010' LIMIT 1",
    );
    expect(buildPermitsByParcelSql("222529156900010010")).toContain(
      "WHERE parcel_identifier = '222529156900010010'",
    );
    expect(buildPermitsForParcelsSql(["1", "2"], { openOnly: true })).toContain(
      "parcel_identifier IN ('1', '2') AND is_roofing = true AND is_open = true",
    );
    expect(() => buildPermitsForParcelsSql([])).toThrow(/empty/);
  });
});

describe("assertReadOnlySelect", () => {
  it("accepts SELECT and WITH and strips a trailing semicolon", () => {
    expect(assertReadOnlySelect("  SELECT 1;  ")).toBe("SELECT 1");
    expect(assertReadOnlySelect("with x as (select 1) select * from x")).toMatch(/^with/);
  });
  it("rejects multi-statement and non-select input", () => {
    expect(() => assertReadOnlySelect("SELECT 1; DROP TABLE properties")).toThrow(/multiple/);
    expect(() => assertReadOnlySelect("DELETE FROM properties")).toThrow(/only a single SELECT/);
    expect(() => assertReadOnlySelect("")).toThrow(/empty/);
  });
});
