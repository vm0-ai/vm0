import { command } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroAgentsByIdContract } from "@vm0/core";
import { zeroClient$ } from "../../api-client.ts";
import { zeroJobDetail$ } from "./detail.ts";
import { reloadAgents$ } from "../agents-list.ts";

// ---------------------------------------------------------------------------
// Delete agent
// ---------------------------------------------------------------------------

export const deleteZeroJobAgent$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const detail = get(zeroJobDetail$);
    if (!detail) {
      throw new Error("No agent detail loaded");
    }

    const client = get(zeroClient$)(zeroAgentsByIdContract);
    const result = await client.delete({ params: { id: detail.agentId } });
    signal.throwIfAborted();

    if (result.status !== 204) {
      const msg =
        result.status === 401 || result.status === 403 || result.status === 404
          ? result.body.error.message
          : `status ${result.status}`;
      throw new Error(`Delete failed: ${msg}`);
    }

    toast.success("Agent deleted");
    set(reloadAgents$);
  },
);
