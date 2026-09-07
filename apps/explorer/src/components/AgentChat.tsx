"use client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import { useState } from "react";
import { CopyBlock } from "./CopyBlock";
import { Badge } from "./ui";

interface Props {
  enabled: boolean;
  suggestions: Array<{ title: string; prompt: string }>;
}

type Part = UIMessage["parts"][number];

function isToolPart(
  p: Part,
): p is Extract<Part, { type: `tool-${string}` }> | Extract<Part, { type: "dynamic-tool" }> {
  return p.type.startsWith("tool-") || p.type === "dynamic-tool";
}

function toolName(p: Part): string {
  if (p.type === "dynamic-tool") return (p as { toolName: string }).toolName;
  return p.type.replace(/^tool-/, "");
}

function pretty(v: unknown, max = 4000): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
}

/** Chat transcript that shows every tool call (input, SQL, row counts) inline, so the demo can point at the evidence. */
export function AgentChat({ enabled, suggestions }: Props) {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error, stop, setMessages } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const busy = status === "submitted" || status === "streaming";

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busy || !enabled) return;
    void sendMessage({ text: t });
    setInput("");
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_18rem]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="card min-h-[24rem] space-y-4">
          {messages.length === 0 ? (
            <div className="text-sm text-zinc-500">
              Ask a roofing-lead question. The agent restates the scope, reads the schema, runs
              read-only SQL through the MCP and answers with parcel ids and source URLs. Tool calls
              are shown inline.
            </div>
          ) : null}
          {messages.map((m) => (
            <div
              key={m.id}
              className={
                m.role === "user"
                  ? "ml-auto max-w-[85%] rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white"
                  : "max-w-full space-y-2"
              }
            >
              {m.parts.map((part, i) => {
                if (part.type === "text")
                  return m.role === "user" ? (
                    <span key={i}>{part.text}</span>
                  ) : (
                    <div key={i} className="prose-sm max-w-none text-sm whitespace-pre-wrap">
                      {part.text}
                    </div>
                  );
                if (part.type === "reasoning") return null;
                if (isToolPart(part)) {
                  const name = toolName(part);
                  const input = (part as { input?: unknown }).input;
                  const output = (part as { output?: unknown }).output;
                  const state = (part as { state: string }).state;
                  const errorText = (part as { errorText?: string }).errorText;
                  const sql =
                    typeof input === "object" && input && "sql" in input
                      ? (input as { sql: string }).sql
                      : null;
                  const rowCount =
                    typeof output === "object" && output && "rowCount" in output
                      ? (output as { rowCount: number }).rowCount
                      : null;
                  return (
                    <details
                      key={i}
                      className="rounded-md border border-zinc-200 bg-zinc-50 text-xs dark:border-zinc-800 dark:bg-zinc-900"
                      open={state !== "output-available"}
                    >
                      <summary className="cursor-pointer px-2 py-1">
                        <Badge
                          tone={
                            state === "output-available"
                              ? "ok"
                              : state === "output-error"
                                ? "bad"
                                : "warn"
                          }
                        >
                          {state === "output-available"
                            ? "done"
                            : state === "output-error"
                              ? "error"
                              : "running"}
                        </Badge>{" "}
                        <span className="font-mono">{name}</span>
                        {rowCount != null ? (
                          <span className="text-zinc-500"> · {rowCount} rows</span>
                        ) : null}
                        {sql ? <span className="text-zinc-500"> · SQL</span> : null}
                      </summary>
                      <div className="space-y-2 px-2 pb-2">
                        {sql ? (
                          <CopyBlock label="SQL sent to the MCP" text={sql} />
                        ) : input !== undefined ? (
                          <CopyBlock label="input" text={pretty(input)} />
                        ) : null}
                        {output !== undefined ? (
                          <CopyBlock label="output" text={pretty(output)} />
                        ) : null}
                        {errorText ? <div className="text-rose-700">{errorText}</div> : null}
                      </div>
                    </details>
                  );
                }
                return null;
              })}
            </div>
          ))}
          {busy ? (
            <div className="text-xs text-zinc-500">Thinking… (model + MCP round trips)</div>
          ) : null}
          {error ? (
            <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
              {error.message}
            </div>
          ) : null}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
        >
          <input
            className="input"
            placeholder={
              enabled
                ? "Which properties within five miles of Kissimmee have roofs older than 15 years?"
                : "Agent disabled (missing ANTHROPIC_API_KEY)"
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!enabled || busy}
          />
          {busy ? (
            <button type="button" className="btn" onClick={() => void stop()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={!enabled || !input.trim()}>
              Ask
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => setMessages([])}
            disabled={busy || messages.length === 0}
          >
            Clear
          </button>
        </form>
      </div>
      <aside className="flex flex-col gap-3">
        <div className="card">
          <div className="mb-2 text-sm font-medium">Demo prompts</div>
          <div className="flex flex-col gap-2">
            {suggestions.map((s) => (
              <button
                key={s.title}
                type="button"
                className="btn h-auto justify-start text-left text-xs whitespace-normal"
                disabled={!enabled || busy}
                onClick={() => submit(s.prompt)}
              >
                <span>
                  <span className="block font-medium">{s.title}</span>
                  <span className="text-zinc-500">{s.prompt}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="card text-xs text-zinc-600 dark:text-zinc-300">
          <div className="mb-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            How it works
          </div>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              Tools: getSchema, geocodePlace (offline gazetteer), queryProperties, queryPermits,
              findPropertiesInArea — all Zod-typed.
            </li>
            <li>
              Every data tool is a call to the Elephant MCP over Parquet; the agent never touches
              DuckDB or files directly.
            </li>
            <li>
              Single read-only SELECT per call, rows capped at 200, methodology and source URLs in
              every answer.
            </li>
            <li>Missing data (e.g. BBB rating not yet matched) is stated, never invented.</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}
