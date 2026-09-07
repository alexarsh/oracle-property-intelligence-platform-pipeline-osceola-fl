/**
 * Great-circle distance helpers shared by the SQL builder (as a DuckDB
 * expression) and the UI (as a JS function for client-side sorting/labels).
 *
 * @module geo/haversine
 */

/** Earth radius in statute miles (matches the SQL expression). */
export const EARTH_RADIUS_MILES = 3958.8;

/** Haversine distance in miles between two WGS84 points. */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(a));
}

/** Axis-aligned bounding box (degrees) that fully contains a radius circle; used as a cheap pre-filter. */
export function bboxAround(
  lat: number,
  lng: number,
  radiusMiles: number,
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const dLat = radiusMiles / 69.0;
  const dLng = radiusMiles / (69.0 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}
