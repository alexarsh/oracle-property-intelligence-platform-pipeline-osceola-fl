import { describe, expect, it } from "vitest";
import { cleanText, labelKey, normalizeParcelNumber, normalizePhone, parseMoney, toIsoDate, toPortalDate } from "./normalize.js";

describe("normalizeParcelNumber", () => {
  it("strips separators and keeps alphanumerics upper-cased", () => {
    expect(normalizeParcelNumber("25-26-28-6100-0522-0080")).toBe("252628610005220080");
    expect(normalizeParcelNumber(" 31 25 29 0000 0015 a000 ")).toBe("31252900000015A000");
    expect(normalizeParcelNumber("3125290000015A0000")).toBe("3125290000015A0000");
  });
  it("returns null for empty input", () => {
    expect(normalizeParcelNumber(null)).toBeNull();
    expect(normalizeParcelNumber("")).toBeNull();
    expect(normalizeParcelNumber(" - ")).toBeNull();
  });
});

describe("normalizePhone", () => {
  it("returns 10 digits", () => {
    expect(normalizePhone("(352) 748-6300")).toBe("3527486300");
    expect(normalizePhone("1-352-748-6300")).toBe("3527486300");
    expect(normalizePhone("3527486300")).toBe("3527486300");
  });
  it("returns null for anything else", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("748-6300")).toBeNull();
    expect(normalizePhone("+44 20 7946 0958")).toBeNull();
  });
});

describe("dates and money", () => {
  it("converts portal dates to ISO", () => {
    expect(toIsoDate("09/04/2026")).toBe("2026-09-04");
    expect(toIsoDate("9/4/2026 10:15 AM")).toBe("2026-09-04");
    expect(toIsoDate("")).toBeNull();
    expect(toIsoDate("2026-09-04")).toBeNull();
  });
  it("converts ISO to portal dates", () => {
    expect(toPortalDate("2026-09-04")).toBe("09/04/2026");
    expect(() => toPortalDate("09/04/2026")).toThrow();
  });
  it("parses money", () => {
    expect(parseMoney("22599.00")).toBe(22599);
    expect(parseMoney("$12,500.50")).toBe(12500.5);
    expect(parseMoney("n/a")).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });
  it("cleans text and labels", () => {
    expect(cleanText("  a   b\n c ")).toBe("a b c");
    expect(cleanText("   ")).toBeNull();
    expect(labelKey("Construction Value: ")).toBe("Construction Value");
  });
});
