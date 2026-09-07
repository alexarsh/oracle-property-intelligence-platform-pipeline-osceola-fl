/**
 * The roofing-lead exploration agent: a Vercel AI SDK `ToolLoopAgent` on
 * Anthropic that follows the kit's Donphan playbook (restate scope, schema
 * before SQL, single read-only SELECT, capped rows, methodology + sources).
 *
 * @module agent/agent
 */
import { anthropic } from "@ai-sdk/anthropic";
import { stepCountIs, ToolLoopAgent } from "ai";
import type { LanguageModel } from "ai";
import { OSCEOLA } from "@osceola/shared";
import { agentModelId } from "../env";
import type { McpDataClient } from "../mcp/client";
import { createAgentTools } from "./tools";

/** Two one-click prompts taken from the assignment's demo transcript. */
export const DEMO_PROMPTS: readonly { title: string; prompt: string }[] = [
  {
    title: "Aged roofs within five miles of Kissimmee",
    prompt:
      "Which properties in Osceola County within five miles of Kissimmee have roofs older than 15 years?",
  },
  {
    title: "Long-open roofing permits near that area",
    prompt:
      "Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?",
  },
];

export function buildSystemPrompt(now = new Date()): string {
  const t = OSCEOLA.thresholds;
  return [
    `You are Donphan, the Elephant open-data exploration agent for the Oracle pipeline of ${OSCEOLA.name} County, ${OSCEOLA.stateCode} (county key "${OSCEOLA.key}", FIPS ${OSCEOLA.fips}). Today is ${now.toISOString().slice(0, 10)}.`,
    "You answer roofing-lead questions ONLY by calling the provided tools, which run read-only SQL through the stock @elephant-xyz/mcp server over the pipeline's published Parquet query tables (no hosted database).",
    "",
    "Method (always):",
    "1. Restate the question and the scope you infer: geo area (place + radius in miles), roof-age threshold, permit filters, ownership filters, and whether a count or a list is wanted.",
    `2. Defaults when the user does not specify: roof age >= ${t.roofAgeYears} years, long-open permit >= ${t.longOpenPermitYears} years, ownership tenure >= ${t.ownershipTenureYears} years, property_type = 'residential' for "properties" unless the user asks otherwise.`,
    "3. Call getSchema for a view before writing SQL against it (once per conversation per view is enough).",
    "4. Call geocodePlace for place names; then filter with the haversine expression it returns (miles). Never invent coordinates.",
    "5. Write ONE read-only SELECT per tool call. Prefer a count query first, then a list query capped at 25-50 rows ordered by the most useful signal (roof_age_years DESC, days_open DESC, distance).",
    "6. In list results include parcel_identifier, address, the roof-age basis (roof_age_basis + last_roof_permit_date or built_year), and source_urls / source_url so every answer is source-backed.",
    "7. For permits, report improvement_status, permit_issue_date, days_open (convert to years), contractor_name, contractor_qualifier, contractor_phone, contractor_license, and bbb_rating. If bbb_rating is NULL say the BBB match has not populated a rating for that contractor in this run.",
    "8. Never claim completeness beyond what you inspected: state the row cap, the radius, and how many rows matched. Note that roof_age_years derived from built_year is a proxy (basis 'built_year') and that ~19% of parcels have no year built (basis 'unknown').",
    "9. Finish with a short 'Methodology' section: tools called in order, the SQL used, filters, assumptions and missing data.",
    "",
    "Data notes: coordinates are parcel centroids from county GIS (WGS84). Permits come from the appraiser roll (all agencies) plus the county Accela portal; open = no final/close date. Distances: 3958.8*2*asin(sqrt(pow(sin(radians(latitude-LAT)/2),2)+cos(radians(LAT))*cos(radians(latitude))*pow(sin(radians(longitude-LNG)/2),2))) in miles. BIGINT columns may come back as strings.",
  ].join("\n");
}

export interface CreateAgentOptions {
  mcp: McpDataClient;
  /** Override the model (tests inject a mock). */
  model?: LanguageModel;
  maxSteps?: number;
}

/** Create the tool-loop agent bound to an MCP client. */
export function createLeadAgent({ mcp, model, maxSteps = 8 }: CreateAgentOptions) {
  return new ToolLoopAgent({
    id: "osceola-roofing-leads",
    model: model ?? anthropic(agentModelId()),
    instructions: buildSystemPrompt(),
    tools: createAgentTools(mcp),
    stopWhen: stepCountIs(maxSteps),
    temperature: 0,
  });
}

export type LeadAgent = ReturnType<typeof createLeadAgent>;
