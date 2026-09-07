import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCategoryUrl, buildSearchApiPath, parseCategoryPage, parseSearchResult } from "./category.js";

const fixtures = new URL("./__fixtures__/", import.meta.url);
const page2Html = readFileSync(new URL("category-kissimmee-roofing-p2.html", fixtures), "utf8");
const apiJson = JSON.parse(readFileSync(new URL("search-api-kissimmee-distance-p1.json", fixtures), "utf8")) as unknown;

describe("parseCategoryPage (real page 2 of Roofing Contractors near Kissimmee)", () => {
  const listing = parseCategoryPage(page2Html);

  it("reads pagination from the embedded state", () => {
    expect(listing.page).toBe(2);
    expect(listing.totalPages).toBe(15);
    expect(listing.hasNext).toBe(true);
    expect(listing.totalResults).toBeGreaterThan(1000);
  });

  it("lists 15 unique absolute profile URLs", () => {
    expect(listing.profileUrls).toHaveLength(15);
    expect(new Set(listing.profileUrls).size).toBe(15);
    for (const u of listing.profileUrls) expect(u).toMatch(/^https:\/\/www\.bbb\.org\/us\/[a-z]{2}\/[a-z-]+\/profile\/[^?#]+$/);
  });

  it("exposes the search text/location the API needs", () => {
    expect(listing.searchText).toBe("Roofing Contractors");
    expect(listing.searchLocation).toBe("Kissimmee, FL");
  });

  it("captures listing-level fields", () => {
    const r = listing.results[0]!;
    expect(r.bbbId).toMatch(/^\d{3,4}-\d+$/);
    expect(r.name.length).toBeGreaterThan(0);
    expect(r.name).not.toContain("<em>");
    expect(r.state).toBe("FL");
    expect(listing.results.some((x) => x.rating !== null)).toBe(true);
    expect(listing.results.some((x) => x.ratingScore !== null)).toBe(true);
    expect(listing.results.some((x) => x.phones.length > 0)).toBe(true);
    expect(listing.results.every((x) => x.categories.length > 0)).toBe(true);
  });
});

describe("parseCategoryPage (markup fallback when the state is missing)", () => {
  const stripped = page2Html.replace("window.__PRELOADED_STATE__", "window.__SOMETHING_ELSE__");
  const listing = parseCategoryPage(stripped);

  it("still finds the profile links and the next page", () => {
    expect(listing.profileUrls.length).toBeGreaterThanOrEqual(15);
    expect(listing.page).toBe(2);
    expect(listing.hasNext).toBe(true);
    expect(listing.searchText).toBeNull();
  });
});

describe("parseSearchResult (real /api/search body, sort=Distance)", () => {
  const listing = parseSearchResult(apiJson);
  it("parses the JSON exactly like the HTML state", () => {
    expect(listing.page).toBe(1);
    expect(listing.totalPages).toBe(15);
    expect(listing.hasNext).toBe(true);
    expect(listing.results.length).toBeGreaterThanOrEqual(14); // 15 items; the fixture contains one duplicate bbbId
    expect(listing.results[0]!.name).toBe("Nelson Arburola Contractor Quality Roofing");
    expect(listing.results[0]!.city).toBe("Kissimmee");
  });
  it("de-duplicates by bbbId within a page", () => {
    const ids = listing.results.map((r) => r.bbbId);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("reports no next page on the last page and tolerates junk", () => {
    expect(parseSearchResult({ page: 15, totalPages: 15, results: [] }).hasNext).toBe(false);
    expect(parseSearchResult(null).results).toEqual([]);
    expect(parseSearchResult({ results: [{ businessName: "x" }] }).results).toEqual([]); // no reportUrl → dropped
  });
});

describe("URL builders", () => {
  it("builds category URLs", () => {
    expect(buildCategoryUrl("saint-cloud", "roofing-contractors")).toBe("https://www.bbb.org/us/fl/saint-cloud/category/roofing-contractors");
    expect(buildCategoryUrl("orlando", "roofing-contractors", 3)).toBe("https://www.bbb.org/us/fl/orlando/category/roofing-contractors?page=3");
  });
  it("builds the same-origin search API path", () => {
    expect(buildSearchApiPath({ text: "Roofing Contractors", location: "Kissimmee, FL", page: 2 })).toBe(
      "/api/search?find_country=USA&find_text=Roofing+Contractors&find_loc=Kissimmee%2C+FL&page=2",
    );
    expect(buildSearchApiPath({ text: "Roofing Contractors", location: "Orlando, FL", page: 1, sort: "Distance", filterCategory: "10126-210" })).toBe(
      "/api/search?find_country=USA&find_text=Roofing+Contractors&find_loc=Orlando%2C+FL&page=1&sort=Distance&filter_category=10126-210",
    );
  });
});
