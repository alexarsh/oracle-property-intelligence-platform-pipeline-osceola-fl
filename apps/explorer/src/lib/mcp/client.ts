/**
 * Minimal MCP client used by every server-side data read in the explorer.
 *
 * The explorer never opens the Parquet files or DuckDB itself: all reads go
 * through the stock `@elephant-xyz/mcp` server (streamable HTTP), exactly the
 * way an external agent or the roofing CRM would reach the data.
 *
 * @module mcp/client
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mcpAuthToken, mcpUrl } from "../env";

/** The narrow surface the typed wrappers and agent tools depend on (easy to fake in tests). */
export interface McpDataClient {
  /** Call a tool and return its first text content parsed as JSON. */
  callToolJson(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** `tools/list` — used by the /mcp page. */
  listTools(): Promise<McpToolInfo[]>;
}

export interface McpToolInfo {
  name: string;
  description: string | null;
  inputSchema: unknown;
}

/** Raised when the MCP returns a tool-level `{error, details}` payload. */
export class McpToolError extends Error {
  constructor(
    public readonly tool: string,
    message: string,
    public readonly details: string | null,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

interface TextContent {
  type: string;
  text?: string;
}

function firstText(result: unknown): string {
  const content = (result as { content?: TextContent[] }).content;
  const text = content?.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") throw new Error("MCP tool returned no text content");
  return text;
}

function isToolError(v: unknown): v is { error: string; details?: string } {
  return (
    typeof v === "object" && v !== null && typeof (v as { error?: unknown }).error === "string"
  );
}

/**
 * Create a short-lived client against the configured MCP endpoint. The server is
 * stateless, so a fresh connection per call is cheap and avoids leaking sessions
 * across serverless invocations.
 */
export function createMcpClient(
  options: { url?: string; token?: string | null } = {},
): McpDataClient {
  const url = options.url ?? mcpUrl();
  const token = options.token === undefined ? mcpAuthToken() : options.token;

  async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: "osceola-explorer", version: "0.1.0" });
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  return {
    async callToolJson(name, args) {
      return withClient(async (client) => {
        const result = await client.callTool({ name, arguments: args });
        const parsed: unknown = JSON.parse(firstText(result));
        if (isToolError(parsed)) throw new McpToolError(name, parsed.error, parsed.details ?? null);
        return parsed;
      });
    },
    async listTools() {
      return withClient(async (client) => {
        const res = await client.listTools();
        return res.tools.map((t) => ({
          name: t.name,
          description: t.description ?? null,
          inputSchema: t.inputSchema,
        }));
      });
    },
  };
}
