import { describe, expect, it } from "vitest";
import { bboxAround, haversineMiles } from "./haversine";

describe("haversineMiles", () => {
  it("is zero for identical points and symmetric", () => {
    expect(haversineMiles(28.29, -81.4, 28.29, -81.4)).toBe(0);
    const a = haversineMiles(28.2919, -81.4076, 28.2489, -81.2812);
    const b = haversineMiles(28.2489, -81.2812, 28.2919, -81.4076);
    expect(a).toBeCloseTo(b, 10);
  });
  it("Kissimmee → St. Cloud is about 8.2 miles", () => {
    expect(haversineMiles(28.2919, -81.4076, 28.2489, -81.2812)).toBeCloseTo(8.2, 0);
  });
  it("one degree of latitude is about 69 miles", () => {
    expect(haversineMiles(28, -81, 29, -81)).toBeCloseTo(69.1, 0);
  });
});

describe("bboxAround", () => {
  it("contains the radius circle", () => {
    const b = bboxAround(28.29, -81.4, 5);
    expect(haversineMiles(28.29, -81.4, b.maxLat, -81.4)).toBeGreaterThanOrEqual(5);
    expect(haversineMiles(28.29, -81.4, 28.29, b.maxLng)).toBeGreaterThanOrEqual(5);
    expect(b.minLat).toBeLessThan(28.29);
    expect(b.minLng).toBeLessThan(-81.4);
  });
});
