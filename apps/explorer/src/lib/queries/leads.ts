/**
 * Named roofing-lead queries. Each one composes a SQL builder with the MCP
 * wrappers and returns normalized, typed rows for the UI and the agent.
 *
 * @module queries/leads
 */
import type { McpDataClient } from "../mcp/client";
import {
  buildPermitsByParcelSql,
  buildPermitsForParcelsSql,
  buildPropertyByParcelSql,
  buildRadiusPermitsSql,
  buildRadiusPropertiesCountSql,
  buildRadiusPropertiesSql,
} from "../mcp/sql";
import type { RadiusPermitsOptions, RadiusPropertiesOptions } from "../mcp/sql";
import { queryPermits, queryProperties, toBool, toNumber, toStr } from "../mcp/tools";
import type { Row } from "../mcp/tools";

export interface LeadProperty {
  propertyId: string;
  parcelIdentifier: string;
  addressStreet: string | null;
  addressCity: string | null;
  addressZip: string | null;
  latitude: number;
  longitude: number;
  propertyType: string | null;
  propertyUsageType: string | null;
  builtYear: number | null;
  effectiveYear: number | null;
  roofAgeYears: number | null;
  roofAgeBasis: string | null;
  lastRoofPermitDate: string | null;
  openRoofPermitCount: number;
  oldestOpenRoofPermitDays: number | null;
  permitCount: number;
  hasBbbContractor: boolean | null;
  ownerName: string | null;
  ownersText: string | null;
  ownerOccupied: boolean | null;
  ownerMailCity: string | null;
  ownerMailState: string | null;
  ownerOutOfState: boolean | null;
  ownerOutOfCounty: boolean | null;
  lastSaleDate: string | null;
  lastSalePrice: number | null;
  yearsSinceSale: number | null;
  marketValue: number | null;
  livableFloorArea: number | null;
  sourceUrls: string[];
  firstSeenRunId: string | null;
  lastChangedRunId: string | null;
  distanceMiles: number | null;
}

export interface LeadPermit {
  permitId: string;
  propertyId: string | null;
  parcelIdentifier: string | null;
  permitNumber: string | null;
  improvementType: string | null;
  status: string | null;
  action: string | null;
  issueDate: string | null;
  openedDate: string | null;
  closeDate: string | null;
  finalInspectionDate: string | null;
  completionDate: string | null;
  expirationDate: string | null;
  isRoofing: boolean;
  isOpen: boolean;
  daysOpen: number | null;
  issuingAgency: string | null;
  description: string | null;
  estimatedJobValue: number | null;
  contractorName: string | null;
  contractorQualifier: string | null;
  contractorPhone: string | null;
  contractorLicense: string | null;
  contractorId: string | null;
  bbbRating: string | null;
  bbbAccredited: boolean | null;
  bbbProfileUrl: string | null;
  bbbMatchMethod: string | null;
  latitude: number | null;
  longitude: number | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressZip: string | null;
  sourceSystem: string | null;
  sourceUrl: string | null;
  fetchedAt: string | null;
  distanceMiles: number | null;
}

/** Map a raw `properties` row to {@link LeadProperty}; rows without coordinates are skipped. */
export function toLeadProperty(r: Row): LeadProperty | null {
  const latitude = toNumber(r.latitude);
  const longitude = toNumber(r.longitude);
  const propertyId = toStr(r.property_id);
  const parcelIdentifier = toStr(r.parcel_identifier);
  if (latitude == null || longitude == null || !propertyId || !parcelIdentifier) return null;
  return {
    propertyId,
    parcelIdentifier,
    addressStreet: toStr(r.address_street),
    addressCity: toStr(r.address_city),
    addressZip: toStr(r.address_zip),
    latitude,
    longitude,
    propertyType: toStr(r.property_type),
    propertyUsageType: toStr(r.property_usage_type),
    builtYear: toNumber(r.built_year),
    effectiveYear: toNumber(r.effective_year),
    roofAgeYears: toNumber(r.roof_age_years),
    roofAgeBasis: toStr(r.roof_age_basis),
    lastRoofPermitDate: toStr(r.last_roof_permit_date),
    openRoofPermitCount: toNumber(r.open_roof_permit_count) ?? 0,
    oldestOpenRoofPermitDays: toNumber(r.oldest_open_roof_permit_days),
    permitCount: toNumber(r.permit_count) ?? 0,
    hasBbbContractor: toBool(r.has_bbb_contractor),
    ownerName: toStr(r.owner_name),
    ownersText: toStr(r.owners_text),
    ownerOccupied: toBool(r.owner_occupied),
    ownerMailCity: toStr(r.owner_mail_city),
    ownerMailState: toStr(r.owner_mail_state),
    ownerOutOfState: toBool(r.owner_out_of_state),
    ownerOutOfCounty: toBool(r.owner_out_of_county),
    lastSaleDate: toStr(r.last_sale_date),
    lastSalePrice: toNumber(r.last_sale_price),
    yearsSinceSale: toNumber(r.years_since_sale),
    marketValue: toNumber(r.market_value),
    livableFloorArea: toNumber(r.livable_floor_area),
    sourceUrls: splitUrls(toStr(r.source_urls)),
    firstSeenRunId: toStr(r.first_seen_run_id),
    lastChangedRunId: toStr(r.last_changed_run_id),
    distanceMiles: toNumber(r.distance_miles),
  };
}

/** Map a raw `permits` row to {@link LeadPermit}. */
export function toLeadPermit(r: Row): LeadPermit | null {
  const permitId = toStr(r.property_improvement_id);
  if (!permitId) return null;
  return {
    permitId,
    propertyId: toStr(r.property_id),
    parcelIdentifier: toStr(r.parcel_identifier),
    permitNumber: toStr(r.permit_number),
    improvementType: toStr(r.improvement_type),
    status: toStr(r.improvement_status),
    action: toStr(r.improvement_action),
    issueDate: toStr(r.permit_issue_date),
    openedDate: toStr(r.opened_date),
    closeDate: toStr(r.permit_close_date),
    finalInspectionDate: toStr(r.final_inspection_date),
    completionDate: toStr(r.completion_date),
    expirationDate: toStr(r.expiration_date),
    isRoofing: toBool(r.is_roofing) ?? false,
    isOpen: toBool(r.is_open) ?? false,
    daysOpen: toNumber(r.days_open),
    issuingAgency: toStr(r.issuing_agency),
    description: toStr(r.description),
    estimatedJobValue: toNumber(r.estimated_job_value),
    contractorName: toStr(r.contractor_name),
    contractorQualifier: toStr(r.contractor_qualifier),
    contractorPhone: toStr(r.contractor_phone),
    contractorLicense: toStr(r.contractor_license),
    contractorId: toStr(r.contractor_id),
    bbbRating: toStr(r.bbb_rating),
    bbbAccredited: toBool(r.bbb_accredited),
    bbbProfileUrl: toStr(r.bbb_profile_url),
    bbbMatchMethod: toStr(r.bbb_match_method),
    latitude: toNumber(r.latitude),
    longitude: toNumber(r.longitude),
    addressStreet: toStr(r.address_street),
    addressCity: toStr(r.address_city),
    addressZip: toStr(r.address_zip),
    sourceSystem: toStr(r.source_system),
    sourceUrl: toStr(r.source_url),
    fetchedAt: toStr(r.fetched_at),
    distanceMiles: toNumber(r.distance_miles),
  };
}

/** Split the `' | '`-separated `source_urls` column into unique URLs. */
export function splitUrls(s: string | null): string[] {
  if (!s) return [];
  return [
    ...new Set(
      s
        .split("|")
        .map((u) => u.trim())
        .filter((u) => u.length > 0),
    ),
  ];
}

export interface RadiusLeadsResult {
  sql: string;
  /** Total matches regardless of the row cap (separate count query with the same WHERE clause). */
  total: number;
  countSql: string;
  /** When the long-open filter is on: the permit query that selected the parcels first. */
  longOpenPermitsSql: string | null;
  properties: LeadProperty[];
  /** Roofing permits for the returned parcels (open first), keyed by parcel. */
  permitsByParcel: Record<string, LeadPermit[]>;
  permitsSql: string | null;
  truncated: boolean;
}

/**
 * Properties within a radius that match the lead filters, enriched with the
 * roofing permits on those parcels (second MCP round trip).
 */
export async function radiusLeads(
  mcp: McpDataClient,
  opts: RadiusPropertiesOptions & { includePermits?: boolean },
): Promise<RadiusLeadsResult> {
  const limit = opts.limit ?? 500;
  let effective: RadiusPropertiesOptions = opts;
  let longOpenPermitsSql: string | null = null;
  // "Open > N years" is answered from the permits table (days_open is maintained per permit),
  // then the property list is restricted to those parcels. This avoids relying on the
  // property-level oldest_open_roof_permit_days roll-up, which is sparsely populated.
  if (opts.openRoofPermitMinYears != null) {
    longOpenPermitsSql = buildRadiusPermitsSql({
      lat: opts.lat,
      lng: opts.lng,
      radiusMiles: opts.radiusMiles,
      minDaysOpen: Math.round(opts.openRoofPermitMinYears * 365.25),
      limit: 1000,
    });
    const pres = await queryPermits(mcp, longOpenPermitsSql, 1000);
    const parcels = [
      ...new Set(pres.rows.map((r) => toStr(r.parcel_identifier)).filter((p): p is string => !!p)),
    ];
    if (parcels.length === 0) {
      return {
        sql: "",
        total: 0,
        countSql: "",
        longOpenPermitsSql,
        properties: [],
        permitsByParcel: {},
        permitsSql: null,
        truncated: false,
      };
    }
    effective = {
      ...opts,
      openRoofPermitMinYears: null,
      openRoofPermits: false,
      parcelIdentifiers: parcels.slice(0, 1000),
    };
  }
  const sql = buildRadiusPropertiesSql({ ...effective, limit });
  const countSql = buildRadiusPropertiesCountSql(effective);
  const [res, countRes] = await Promise.all([
    queryProperties(mcp, sql, limit),
    queryProperties(mcp, countSql, 1),
  ]);
  const total = toNumber(countRes.rows[0]?.total) ?? res.rowCount;
  const properties = res.rows.map(toLeadProperty).filter((p): p is LeadProperty => p !== null);
  const permitsByParcel: Record<string, LeadPermit[]> = {};
  let permitsSql: string | null = null;
  const withPermits = properties.filter((p) => p.permitCount > 0).map((p) => p.parcelIdentifier);
  if ((opts.includePermits ?? true) && withPermits.length > 0) {
    permitsSql = buildPermitsForParcelsSql(withPermits.slice(0, 500), {
      roofingOnly: true,
      openOnly: false,
      limit: 1000,
    });
    const pres = await queryPermits(mcp, permitsSql, 1000);
    for (const row of pres.rows) {
      const permit = toLeadPermit(row);
      if (!permit?.parcelIdentifier) continue;
      (permitsByParcel[permit.parcelIdentifier] ??= []).push(permit);
    }
  }
  return {
    sql,
    total,
    countSql,
    longOpenPermitsSql,
    properties,
    permitsByParcel,
    permitsSql,
    truncated: total > properties.length,
  };
}

/** Open roofing permits within a radius, longest-open first. */
export async function radiusOpenRoofingPermits(
  mcp: McpDataClient,
  opts: RadiusPermitsOptions,
): Promise<{ sql: string; permits: LeadPermit[] }> {
  const sql = buildRadiusPermitsSql(opts);
  const res = await queryPermits(mcp, sql, opts.limit ?? 200);
  return { sql, permits: res.rows.map(toLeadPermit).filter((p): p is LeadPermit => p !== null) };
}

/** Full property record plus every permit on the parcel (for the drawer). */
export async function propertyDetail(
  mcp: McpDataClient,
  parcelIdentifier: string,
): Promise<{
  property: LeadProperty | null;
  raw: Row | null;
  permits: LeadPermit[];
  sql: { property: string; permits: string };
}> {
  const propertySql = buildPropertyByParcelSql(parcelIdentifier);
  const permitsSql = buildPermitsByParcelSql(parcelIdentifier);
  const [p, q] = await Promise.all([
    queryProperties(mcp, propertySql, 1),
    queryPermits(mcp, permitsSql, 200),
  ]);
  const raw = p.rows[0] ?? null;
  return {
    property: raw ? toLeadProperty(raw) : null,
    raw,
    permits: q.rows.map(toLeadPermit).filter((x): x is LeadPermit => x !== null),
    sql: { property: propertySql, permits: permitsSql },
  };
}
