/**
 * Presentation helpers (pure, safe on server and client).
 *
 * @module format
 */

/** Lossless-ish string for an unknown cell value (objects as JSON, primitives via String). */
export function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}

export function fmtInt(n: number | null | undefined): string {
  return n == null ? "—" : new Intl.NumberFormat("en-US").format(n);
}

export function fmtDelta(n: number | null | undefined): string {
  if (n == null) return "—";
  return n > 0 ? `+${fmtInt(n)}` : fmtInt(n);
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function fmtMoney(n: number | null | undefined): string {
  return n == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(n);
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") || iso.includes(" ") ? iso : `${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d+Z$/, "Z");
}

export function fmtDaysOpen(days: number | null | undefined): string {
  if (days == null) return "—";
  if (days < 365) return `${days} d`;
  return `${(days / 365.25).toFixed(1)} y (${fmtInt(days)} d)`;
}

export function shortCid(cid: string | null | undefined, n = 10): string {
  if (!cid) return "—";
  return cid.length <= n * 2 + 1 ? cid : `${cid.slice(0, n)}…${cid.slice(-n)}`;
}

export function pct(n: number): string {
  return `${n.toFixed(n >= 10 || n === 0 ? 0 : 1)}%`;
}
