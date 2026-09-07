"use client";
import { GeoJSONSource, Map as MlMap, Marker, NavigationControl } from "maplibre-gl";
import type { MapMouseEvent, StyleSpecification } from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { LeadProperty } from "@/lib/queries/leads";

interface Props {
  center: { lat: number; lng: number };
  radiusMiles: number;
  properties: readonly LeadProperty[];
  selected: string | null;
  onPick: (lat: number, lng: number) => void;
  onSelect: (parcel: string) => void;
}

const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxzoom: 19,
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

/** GeoJSON circle polygon (radius in miles) for the search area. */
function circle(
  lat: number,
  lng: number,
  miles: number,
  steps = 64,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const km = miles * 1.609344;
  const coords: [number, number][] = [];
  const dLat = km / 110.574;
  const dLng = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    coords.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coords] } };
}

function markerColor(p: LeadProperty): string {
  if (p.openRoofPermitCount > 0) return "#e11d48";
  if ((p.roofAgeYears ?? 0) >= 25) return "#d97706";
  return "#059669";
}

/** MapLibre map with OSM raster tiles, a radius circle, one marker per lead, and click-to-drop-pin. */
export function LeadsMap({ center, radiusMiles, properties, selected, onPick, onSelect }: Props) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MlMap | null>(null);
  const pin = useRef<Marker | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const pickRef = useRef(onPick);
  const selectRef = useRef(onSelect);
  pickRef.current = onPick;
  selectRef.current = onSelect;

  useEffect(() => {
    if (!container.current || map.current) return;
    const m = new MlMap({
      container: container.current,
      style: OSM_STYLE,
      center: [center.lng, center.lat],
      zoom: 11,
      attributionControl: { compact: true },
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      m.addSource("radius", { type: "geojson", data: circle(center.lat, center.lng, radiusMiles) });
      m.addLayer({
        id: "radius-fill",
        type: "fill",
        source: "radius",
        paint: { "fill-color": "#10b981", "fill-opacity": 0.08 },
      });
      m.addLayer({
        id: "radius-line",
        type: "line",
        source: "radius",
        paint: { "line-color": "#059669", "line-width": 2 },
      });
    });
    m.on("click", (e: MapMouseEvent) => pickRef.current(e.lngLat.lat, e.lngLat.lng));
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
    // create once
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      const src = m.getSource("radius");
      if (src instanceof GeoJSONSource)
        void src.setData(circle(center.lat, center.lng, radiusMiles));
    };
    if (m.isStyleLoaded()) apply();
    else void m.once("load", apply);
    if (!pin.current) {
      const el = document.createElement("div");
      el.style.cssText =
        "width:18px;height:18px;border-radius:50%;background:#2563eb;border:3px solid white;box-shadow:0 0 0 2px #2563eb";
      pin.current = new Marker({ element: el }).setLngLat([center.lng, center.lat]).addTo(m);
    } else pin.current.setLngLat([center.lng, center.lat]);
    m.easeTo({ center: [center.lng, center.lat], duration: 500 });
  }, [center.lat, center.lng, radiusMiles]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const mk of markers.current.values()) mk.remove();
    markers.current.clear();
    for (const p of properties) {
      const el = document.createElement("button");
      el.type = "button";
      el.title = `${p.addressStreet ?? ""} · roof ${p.roofAgeYears ?? "?"} y (${p.roofAgeBasis ?? "unknown"})`;
      el.style.cssText = `width:10px;height:10px;border-radius:50%;background:${markerColor(p)};border:1.5px solid white;box-shadow:0 0 0 1px rgba(0,0,0,.35);cursor:pointer;padding:0`;
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        selectRef.current(p.parcelIdentifier);
      });
      markers.current.set(
        p.parcelIdentifier,
        new Marker({ element: el }).setLngLat([p.longitude, p.latitude]).addTo(m),
      );
    }
  }, [properties]);

  useEffect(() => {
    for (const [id, mk] of markers.current) {
      const el = mk.getElement();
      const on = id === selected;
      el.style.width = on ? "16px" : "10px";
      el.style.height = on ? "16px" : "10px";
      el.style.zIndex = on ? "10" : "1";
    }
  }, [selected]);

  return (
    <div
      ref={container}
      className="h-[60vh] w-full rounded-lg border border-zinc-200 lg:h-full dark:border-zinc-800"
    />
  );
}
