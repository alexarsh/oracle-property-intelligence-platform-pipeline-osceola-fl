/**
 * Runtime configuration for the explorer. Everything is read lazily so the
 * build never fails on a missing variable; pages render a notice instead.
 *
 * @module env
 */

/** Streamable-HTTP endpoint of the Elephant MCP server that serves our Parquet. */
export function mcpUrl(): string {
  return process.env.ORACLE_MCP_URL ?? "http://localhost:8877/mcp";
}

/** Optional bearer token forwarded to the MCP (`MCP_HTTP_AUTH_TOKEN` on the server side). */
export function mcpAuthToken(): string | null {
  const t = process.env.ORACLE_MCP_AUTH_TOKEN?.trim();
  return t ? t : null;
}

/** Public URL to advertise on /mcp (falls back to the configured endpoint). */
export function mcpPublicUrl(): string {
  return process.env.NEXT_PUBLIC_MCP_PUBLIC_URL?.trim() || mcpUrl();
}

/** Whether the agent page can run (Anthropic key present). */
export function hasAnthropicKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/** Anthropic model id for the agent. */
export function agentModelId(): string {
  return process.env.AGENT_MODEL?.trim() || "claude-sonnet-4-5";
}

/** County key used on every MCP call. */
export const COUNTY_KEY = "osceola";
