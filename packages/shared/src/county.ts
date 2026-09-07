/**
 * County configuration for the Oracle pipeline.
 *
 * Everything county-specific that the pipeline needs to know lives here so that
 * the ingestion stages stay county-generic (the same rule the soofi-xyz kit's
 * `county-discovery` / `onboard-county` skills enforce: sources come from a
 * catalog, never from hard-coded branches inside a stage).
 *
 * @module county
 */

/** A single public data source the pipeline reads from. */
export interface SourceDescriptor {
  /** Stable machine key, also used as `source_system` prefix in every table. */
  readonly key: string;
  /** Human-readable label for run summaries and the UI. */
  readonly label: string;
  /** Publisher / custodian of the data. */
  readonly custodian: string;
  /** Canonical entry URL. */
  readonly url: string;
  /** How the pipeline reads it. */
  readonly accessMode: "bulk-download" | "arcgis-rest" | "portal-search" | "site-crawl";
  /** How often the custodian refreshes it (drives incremental scheduling). */
  readonly cadence: "annual" | "weekly" | "daily" | "continuous" | "unknown";
  /** Known limitations, geo-blocks, TLS quirks — surfaced verbatim in run history. */
  readonly limitations: readonly string[];
}

export interface CountyConfig {
  /** Lowercase-hyphen slug; the ONE key used everywhere (MCP maps, IPNS labels, paths). */
  readonly key: string;
  readonly name: string;
  readonly stateCode: string;
  readonly fips: string;
  /** Bounding box used to sanity-check coordinates (WGS84). */
  readonly bbox: {
    readonly minLat: number;
    readonly maxLat: number;
    readonly minLng: number;
    readonly maxLng: number;
  };
  /** Named demo anchors for radius queries. */
  readonly places: ReadonlyArray<{
    readonly name: string;
    readonly lat: number;
    readonly lng: number;
  }>;
  readonly sources: Readonly<Record<string, SourceDescriptor>>;
  /** Default lead-scoring thresholds (all overridable at query time). */
  readonly thresholds: {
    readonly roofAgeYears: number;
    readonly longOpenPermitYears: number;
    readonly ownershipTenureYears: number;
  };
}

/** Osceola County, FL — the default and primary county for this milestone. */
export const OSCEOLA: CountyConfig = {
  key: "osceola",
  name: "Osceola",
  stateCode: "FL",
  fips: "12097",
  bbox: { minLat: 27.55, maxLat: 28.4, minLng: -81.7, maxLng: -80.85 },
  places: [
    { name: "Kissimmee", lat: 28.2919, lng: -81.4076 },
    { name: "St. Cloud", lat: 28.2489, lng: -81.2812 },
    { name: "Celebration", lat: 28.3253, lng: -81.5331 },
    { name: "Poinciana", lat: 28.1403, lng: -81.4587 },
    { name: "Harmony", lat: 28.1922, lng: -81.1503 },
  ],
  sources: {
    ocpa_certified: {
      key: "ocpa_certified",
      label: "Osceola County Property Appraiser — certified roll export",
      custodian: "Osceola County Property Appraiser (OCPA)",
      url: "https://www.property-appraiser.org/data/",
      accessMode: "bulk-download",
      cadence: "annual",
      limitations: [
        "Annual certified export (one ZIP per tax year, hosted on Dropbox); intra-year changes only appear in the next certification.",
        "Pipe-delimited latin-1 CSVs; ~21k permit rows are truncated/malformed in the source and are quarantined, not dropped.",
        "Contains no coordinates — geometry comes from the county GIS layer.",
      ],
    },
    osceola_gis_parcels: {
      key: "osceola_gis_parcels",
      label: "Osceola County GIS — Parcels feature layer",
      custodian: "Osceola County GIS (ArcGIS Online)",
      url: "https://services6.arcgis.com/9zKHLCgIwu2HFA5O/arcgis/rest/services/Parcels/FeatureServer/0",
      accessMode: "arcgis-rest",
      cadence: "weekly",
      limitations: [
        "Paginated at 2,000 features per request; a full centroid sweep is ~110 requests.",
        "Parcel count (~215.9k) exceeds the appraiser roll (~210.9k): the GIS layer includes right-of-way and non-taxable polygons.",
      ],
    },
    osceola_accela: {
      key: "osceola_accela",
      label: "Osceola County Permit Center — Accela Citizen Access",
      custodian: "Osceola County Building Office",
      url: "https://permits.osceola.org/CitizenAccess/",
      accessMode: "portal-search",
      cadence: "continuous",
      limitations: [
        "Server presents an incomplete TLS chain (missing Entrust intermediate); the pipeline pins the intermediate certificate.",
        "General search is an ASP.NET postback; results are paged 10 at a time and the portal caps a single search at 100 hits, so refresh windows are kept short.",
        "Covers unincorporated Osceola County; City of Kissimmee and City of St. Cloud issue their own permits (present in the appraiser roll as agency K / S).",
      ],
    },
    bbb_roofing: {
      key: "bbb_roofing",
      label: "Better Business Bureau — roofing contractor profiles (Central Florida)",
      custodian: "BBB Serving Central Florida",
      url: "https://www.bbb.org/us/fl/kissimmee/category/roofing-contractors",
      accessMode: "site-crawl",
      cadence: "weekly",
      limitations: [
        "Geo-blocked outside the US and bot-challenged; harvested from US egress at low concurrency. Ratings are matched to permits by license, phone, then normalized name.",
      ],
    },
  },
  thresholds: { roofAgeYears: 15, longOpenPermitYears: 5, ownershipTenureYears: 10 },
};
