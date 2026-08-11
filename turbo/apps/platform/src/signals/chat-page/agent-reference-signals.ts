import { computed, type Computed } from "ccstate";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { agents$ } from "../agent.ts";
import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";

/**
 * Reactive agent data backing one or more structured agent references in a
 * chat thread. The agent is derived from the shared team list, so references
 * do not issue one request per agent.
 */
export interface AgentReferenceSignals {
  readonly agentId: string;
  readonly agent$: Computed<Promise<TeamComposeItem | null>>;
}

export type AgentReferenceSignalsRegistry = CardSignalsRegistry<
  string,
  AgentReferenceSignals
>;

function createAgentReferenceSignals(agentId: string): AgentReferenceSignals {
  return {
    agentId,
    agent$: computed(async (get) => {
      const agents = await get(agents$);
      return (
        agents.find((agent) => {
          return agent.id === agentId;
        }) ?? null
      );
    }),
  };
}

/**
 * Thread-owned registry that gives every referenced agent a stable signal
 * identity across transcript recomputations.
 */
export function createAgentReferenceSignalsRegistry(): AgentReferenceSignalsRegistry {
  return createCardSignalsRegistry((agentId: string) => {
    return agentId;
  }, createAgentReferenceSignals);
}
