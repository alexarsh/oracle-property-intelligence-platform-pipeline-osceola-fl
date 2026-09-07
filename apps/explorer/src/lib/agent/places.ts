/**
 * Offline gazetteer for the agent's `geocodePlace` tool: the county config's
 * demo anchors plus a few Osceola localities. No external geocoder is called,
 * so the agent stays deterministic and free of network side effects.
 *
 * @module agent/places
 */
import { OSCEOLA } from "@osceola/shared";

export interface Place {
  name: string;
  lat: number;
  lng: number;
  /** Where the coordinate comes from. */
  source: "county-config" | "gazetteer";
  aliases?: readonly string[];
}

export const PLACES: readonly Place[] = [
  ...OSCEOLA.places.map((p) => ({
    ...p,
    source: "county-config" as const,
    aliases: p.name === "St. Cloud" ? ["saint cloud", "st cloud"] : [],
  })),
  {
    name: "Buenaventura Lakes",
    lat: 28.3358,
    lng: -81.3531,
    source: "gazetteer",
    aliases: ["bvl"],
  },
  { name: "Four Corners", lat: 28.3328, lng: -81.6473, source: "gazetteer" },
  {
    name: "Campbell",
    lat: 28.2589,
    lng: -81.4562,
    source: "gazetteer",
    aliases: ["campbell city"],
  },
  { name: "Intercession City", lat: 28.2617, lng: -81.5081, source: "gazetteer" },
  { name: "Narcoossee", lat: 28.2908, lng: -81.2047, source: "gazetteer" },
  { name: "Holopaw", lat: 28.1364, lng: -81.0778, source: "gazetteer" },
  { name: "Kenansville", lat: 27.8778, lng: -81.0417, source: "gazetteer" },
  { name: "Yeehaw Junction", lat: 27.7003, lng: -80.9042, source: "gazetteer" },
  { name: "Reunion", lat: 28.2725, lng: -81.6086, source: "gazetteer" },
  {
    name: "Osceola County (centroid)",
    lat: 28.06,
    lng: -81.15,
    source: "gazetteer",
    aliases: ["osceola", "osceola county"],
  },
];

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\bsaint\b/g, "st")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Case/punctuation-insensitive lookup with alias and prefix matching. */
export function geocodePlace(query: string): Place | null {
  const q = norm(query.replace(/,?\s*(fl|florida)\b/gi, ""));
  if (!q) return null;
  const exact = PLACES.find(
    (p) => norm(p.name) === q || (p.aliases ?? []).some((a) => norm(a) === q),
  );
  if (exact) return exact;
  return PLACES.find((p) => norm(p.name).startsWith(q) || q.startsWith(norm(p.name))) ?? null;
}
