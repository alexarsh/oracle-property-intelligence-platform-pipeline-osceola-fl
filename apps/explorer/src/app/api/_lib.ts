/**
 * Shared helpers for route handlers: JSON responses and uniform error bodies.
 *
 * @module api/_lib
 */
import { NextResponse } from "next/server";
import { McpToolError } from "@/lib/mcp/client";

export interface ApiError {
  error: string;
  details?: string | null;
}

export function jsonError(
  message: string,
  status = 400,
  details: string | null = null,
): NextResponse<ApiError> {
  return NextResponse.json({ error: message, details }, { status });
}

/** Map thrown errors to a response without leaking stack traces. */
export function errorResponse(err: unknown): NextResponse<ApiError> {
  if (err instanceof McpToolError)
    return jsonError(`MCP tool ${err.tool} failed: ${err.message}`, 502, err.details);
  if (err instanceof SyntaxError) return jsonError("invalid JSON body", 400);
  const message = err instanceof Error ? err.message : String(err);
  if (/ECONNREFUSED|fetch failed|Failed to fetch|ENOTFOUND/i.test(message))
    return jsonError("MCP endpoint unreachable", 503, message);
  if (
    /must be|unknown|not allowed|contains unsupported|only a single|multiple statements|empty statement/i.test(
      message,
    )
  )
    return jsonError(message, 400);
  return jsonError("internal error", 500, message);
}
