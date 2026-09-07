import { describe, expect, it } from "vitest";
import { geocodePlace } from "./places";

describe("geocodePlace", () => {
  it("resolves county-config anchors exactly", () => {
    expect(geocodePlace("Kissimmee")).toMatchObject({
      name: "Kissimmee",
      lat: 28.2919,
      lng: -81.4076,
      source: "county-config",
    });
  });
  it("is tolerant to case, punctuation, state suffix and aliases", () => {
    expect(geocodePlace("st cloud, FL")?.name).toBe("St. Cloud");
    expect(geocodePlace("Saint Cloud Florida")?.name).toBe("St. Cloud");
    expect(geocodePlace("BVL")?.name).toBe("Buenaventura Lakes");
    expect(geocodePlace("celebration")?.name).toBe("Celebration");
  });
  it("returns null for unknown places", () => {
    expect(geocodePlace("Miami")).toBeNull();
    expect(geocodePlace("")).toBeNull();
  });
});
