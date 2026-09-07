import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";

describe("csv", () => {
  it("quotes cells with commas, quotes and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("x\ny")).toBe('"x\ny"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(12)).toBe("12");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
  it("serializes rows with a header from the union of keys", () => {
    const csv = toCsv([
      { a: 1, b: "x" },
      { a: 2, c: true },
    ]);
    expect(csv).toBe("a,b,c\r\n1,x,\r\n2,,true\r\n");
  });
  it("honours an explicit column order", () => {
    expect(toCsv([{ a: 1, b: 2 }], ["b", "a"])).toBe("b,a\r\n2,1\r\n");
  });
});
