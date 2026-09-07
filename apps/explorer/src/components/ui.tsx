import type { ReactNode } from "react";

/** Page header with title + one-line intent (mirrors the demo transcript line it serves). */
export function PageHeader({
  title,
  transcript,
  children,
}: {
  title: string;
  transcript?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {transcript ? (
          <p className="mt-1 text-sm text-zinc-500 italic">Demo: “{transcript}”</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card">
      <div className="text-xs font-medium tracking-wide text-zinc-500 uppercase">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {sub ? <div className="mt-1 text-xs text-zinc-500">{sub}</div> : null}
    </div>
  );
}

export function Section({
  title,
  description,
  children,
  right,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          {description ? <p className="text-sm text-zinc-500">{description}</p> : null}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "muted";
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Notice({
  tone = "warn",
  children,
}: {
  tone?: "warn" | "bad" | "ok";
  children: ReactNode;
}) {
  const cls =
    tone === "bad"
      ? "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100"
      : tone === "ok"
        ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"
        : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100";
  return <div className={`mb-4 rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

export function KV({ rows }: { rows: ReadonlyArray<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-zinc-500">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ExtLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900 dark:text-emerald-400 dark:decoration-emerald-700"
    >
      {children ?? href}
    </a>
  );
}

export function CoverageBar({ pct: p }: { pct: number }) {
  const tone =
    p >= 90
      ? "bg-emerald-500"
      : p >= 50
        ? "bg-amber-500"
        : p > 0
          ? "bg-rose-500"
          : "bg-zinc-300 dark:bg-zinc-700";
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-28 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
        <div className={`h-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, p))}%` }} />
      </div>
      <span className="w-12 text-right text-xs tabular-nums">
        {p.toFixed(p >= 10 || p === 0 ? 0 : 1)}%
      </span>
    </div>
  );
}
