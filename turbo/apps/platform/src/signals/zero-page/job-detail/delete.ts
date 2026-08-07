import { command } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
import { agentDetail$ } from "./detail.ts";
import { reloadAgents$ } from "../../agent.ts";
import { i18n } from "../../../i18n/index.ts";

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

    toast.success(
      i18n.t(
        ($) => {
          return $.delete.success;
        },
        { ns: "agents" },
      ),
    );
    // Refresh the agents list only. Do NOT reload the agent-by-id cache here:
    // the just-deleted agent is still subscribed via currentAgent$ until the
    // caller navigates away, so reloading it would refetch a deleted agent and
    // surface an "Agent not found" error toast on top of the success toast.
    set(reloadAgents$);
  },
);
