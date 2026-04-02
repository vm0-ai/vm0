import { command, computed, state } from "ccstate";
import { zeroAgentsByIdContract } from "@vm0/core";
import { zeroClient$ } from "../../api-client.ts";
import type { AgentDetail } from "../agent-types.ts";
import { agentName$ } from "./agent-name.ts";

// ---------------------------------------------------------------------------
// Agent detail — reactive async computed
// ---------------------------------------------------------------------------

const internalDetailReload$ = state(0);

export const reloadJobDetail$ = command(({ set }) => {
  set(internalDetailReload$, (prev) => {
    return prev + 1;
  });
});

export const zeroJobDetail$ = computed(
  async (get): Promise<AgentDetail | null> => {
    get(internalDetailReload$);
    const name = get(agentName$);
    if (!name) {
      return null;
    }
    const client = get(zeroClient$)(zeroAgentsByIdContract);
    const result = await client.get({ params: { id: name } });
    if (result.status !== 200) {
      throw new Error(`Failed to fetch agent (${result.status})`);
    }
    return result.body;
  },
);
