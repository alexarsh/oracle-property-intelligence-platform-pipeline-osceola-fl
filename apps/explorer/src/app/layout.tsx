import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "Osceola Oracle Explorer",
  description:
    "Oracle Property Intelligence pipeline for Osceola County, FL — run history, IPFS artifacts, DuckDB-over-Parquet queries via MCP, roofing leads and agent.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen">
        <Nav />
        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">{children}</main>
        <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-zinc-500 sm:px-6">
          Osceola County, FL · CIDs are the identity of every artifact; gateway URLs are derived.
          All data reads go through the Elephant MCP over Parquet — no hosted database.
        </footer>
      </body>
    </html>
  );
}
