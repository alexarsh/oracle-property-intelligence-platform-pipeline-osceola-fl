import { Notice, PageHeader } from "@/components/ui";
import { AgentChat } from "@/components/AgentChat";
import { DEMO_PROMPTS } from "@/lib/agent/agent";
import { agentModelId, hasAnthropicKey, mcpPublicUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function AgentPage() {
  const enabled = hasAnthropicKey();
  return (
    <>
      <PageHeader
        title="Agent"
        transcript="Now I am asking the same type of questions through the agent."
      >
        <div className="text-right text-xs text-zinc-500">
          <div>
            Anthropic <span className="font-mono">{agentModelId()}</span> via Vercel AI SDK
            (ToolLoopAgent)
          </div>
          <div>
            tools → Elephant MCP <span className="font-mono">{mcpPublicUrl()}</span>
          </div>
        </div>
      </PageHeader>
      {!enabled ? (
        <Notice tone="bad">
          The agent is disabled because <code>ANTHROPIC_API_KEY</code> is not set on the server. Add
          it to the environment (Vercel project settings or <code>.env.local</code>) and reload.
          Every other page works without it.
        </Notice>
      ) : null}
      <AgentChat enabled={enabled} suggestions={DEMO_PROMPTS.map((p) => ({ ...p }))} />
    </>
  );
}
