import { command } from "ccstate";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
import { zeroJobDetail$, reloadJobDetail$ } from "./detail.ts";
import { reloadAgentById$, reloadAgents$ } from "../../agent.ts";

// ---------------------------------------------------------------------------
// Settings: update agent metadata (displayName, sound)
// ---------------------------------------------------------------------------

interface ZeroJobSettingsUpdate {
  displayName?: string;
  description?: string;
  sound?: string;
  avatarUrl?: string | null;
  modelProviderId?: string | null;
  selectedModel?: string | null;
}

export const zeroJobUpdateSettings$ = command(
  async ({ get, set }, update: ZeroJobSettingsUpdate, signal: AbortSignal) => {
    const detail = await get(zeroJobDetail$);
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

    set(reloadJobDetail$);
    set(reloadAgents$);
    set(reloadAgentById$);
  },
);
