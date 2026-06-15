import { command } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
import { agentDetail$ } from "./detail.ts";
import { reloadAgentById$, reloadAgents$ } from "../../agent.ts";

// ---------------------------------------------------------------------------
// Delete agent
// ---------------------------------------------------------------------------

export const deleteAgent$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail) {
      throw new Error("No agent detail loaded");
    }

    const client = get(zeroClient$)(zeroAgentsByIdContract);
    await accept(client.delete({ params: { id: detail.agentId } }), [204]);
    signal.throwIfAborted();

    toast.success("Agent deleted");
    set(reloadAgents$);
    set(reloadAgentById$);
  },
);
