import { command } from "ccstate";
import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { apiClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
import { agentDetail$, reloadAgentDetail$ } from "./detail.ts";
import { reloadAgentById$, reloadAgents$ } from "../../agent.ts";
import { syncPinnedAgentPreviewCache$ } from "../pinned-agents.ts";

// ---------------------------------------------------------------------------
// Settings: update agent metadata (displayName, sound)
// ---------------------------------------------------------------------------

interface AgentSettingsUpdate {
  displayName?: string;
  description?: string;
  sound?: string;
  avatarUrl?: string | null;
  modelProviderId?: string | null;
  selectedModel?: string | null;
  preferPersonalProvider?: boolean;
  visibility?: "public" | "private";
}

export const updateAgentSettings$ = command(
  async ({ get, set }, update: AgentSettingsUpdate, signal: AbortSignal) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail) {
      throw new Error("No compose detail found");
    }

    const client = get(apiClient$)(agentsByIdContract);
    await accept(
      client.updateMetadata({
        params: { id: detail.agentId },
        body: update,
      }),
      [200],
    );
    signal.throwIfAborted();

    set(reloadAgentDetail$);
    set(reloadAgents$);
    set(reloadAgentById$);
    await set(syncPinnedAgentPreviewCache$, signal);
  },
);
