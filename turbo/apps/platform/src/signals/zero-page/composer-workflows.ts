import { computed, type Computed } from "ccstate";
import {
  zeroWorkflowsCollectionContract,
  type ZeroWorkflowSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { workflowReloadVersion$ } from "../workflows-page/workflow-reload.ts";

type AgentIdValue = string | null | Promise<string | null>;

export function createComposerWorkflows<T extends AgentIdValue>(
  agentIdSource$: Computed<T>,
): Computed<Promise<readonly ZeroWorkflowSummary[]>> {
  return computed(async (get): Promise<readonly ZeroWorkflowSummary[]> => {
    const agentId = await get(agentIdSource$);
    if (!agentId) {
      return [];
    }
    get(workflowReloadVersion$);
    const client = get(zeroClient$)(zeroWorkflowsCollectionContract);
    const result = await accept(client.list({ query: { agentId } }), [200]);
    return result.body;
  });
}
