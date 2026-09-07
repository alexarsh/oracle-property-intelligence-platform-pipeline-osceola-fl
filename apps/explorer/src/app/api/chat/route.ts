/**
 * `POST /api/chat` — Vercel AI SDK UI-message stream for the agent page.
 *
 * Runs the `ToolLoopAgent` (Anthropic via `@ai-sdk/anthropic`); every data tool
 * goes through the Elephant MCP. Returns 503 with a clear message when
 * `ANTHROPIC_API_KEY` is not configured.
 *
 * @module api/chat
 */
import { createAgentUIStreamResponse } from "ai";
import { NextResponse } from "next/server";
import { jsonError } from "../_lib";
import { createLeadAgent } from "@/lib/agent/agent";
import { hasAnthropicKey } from "@/lib/env";
import { createMcpClient } from "@/lib/mcp/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  if (!hasAnthropicKey())
    return jsonError("ANTHROPIC_API_KEY is not configured on the server", 503);
  let body: { messages?: unknown[] };
  try {
    body = (await req.json()) as { messages?: unknown[] };
  } catch {
    return jsonError("invalid JSON body");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    return jsonError("messages[] is required");
  if (body.messages.length > 60) return jsonError("conversation too long; start a new one");
  try {
    const agent = createLeadAgent({ mcp: createMcpClient() });
    return await createAgentUIStreamResponse({
      agent,
      uiMessages: body.messages,
      abortSignal: req.signal,
      // Surface the real provider/MCP error text instead of the SDK's generic "An error occurred.".
      onError: (error) => (error instanceof Error ? error.message : String(error)),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
