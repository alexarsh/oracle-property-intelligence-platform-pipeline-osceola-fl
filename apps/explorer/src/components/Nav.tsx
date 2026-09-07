"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/", label: "Run summary" },
  { href: "/sources", label: "Sources & coverage" },
  { href: "/manifest", label: "Manifest" },
  { href: "/query", label: "Query" },
  { href: "/leads", label: "Leads map" },
  { href: "/agent", label: "Agent" },
  { href: "/mcp", label: "MCP" },
];

/** Top navigation; highlights the active section. */
export function Nav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:px-6">
        <Link href="/" className="mr-2 font-semibold tracking-tight">
          <span className="text-emerald-600 dark:text-emerald-400">Osceola</span> Oracle Explorer
        </Link>
        <nav className="flex flex-wrap gap-1 text-sm">
          {LINKS.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-md px-2.5 py-1 ${active ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
