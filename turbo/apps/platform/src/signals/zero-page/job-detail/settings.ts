import { command } from "ccstate";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
import { agentDetail$, reloadAgentDetail$ } from "./detail.ts";
import { reloadAgentById$, reloadAgents$ } from "../../agent.ts";

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
}

export const updateAgentSettings$ = command(
  async ({ get, set }, update: AgentSettingsUpdate, signal: AbortSignal) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail) {
      throw new Error("No compose detail found");
    }

    const client = get(zeroClient$)(zeroAgentsByIdContract);
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
  },
);
