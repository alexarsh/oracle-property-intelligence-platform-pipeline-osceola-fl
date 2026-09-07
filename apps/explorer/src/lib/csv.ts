import { cellText } from "./format";

/**
 * Tiny CSV serializer for query-console downloads (RFC 4180 quoting).
 *
 * @module csv
 */

export function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = cellText(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows → CSV text. Columns default to the union of keys in first-seen order. */
export function toCsv(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns?: readonly string[],
): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(csvCell).join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}
