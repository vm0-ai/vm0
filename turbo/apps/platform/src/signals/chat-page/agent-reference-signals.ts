import { computed, type Computed } from "ccstate";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { agents$ } from "../agent.ts";
import {
  getOrCreateCardSignals,
  registeredCardSignals,
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

export interface AgentReferenceSignalsRegistry {
  register(agentId: string): AgentReferenceSignals;
  resolve(agentId: string): AgentReferenceSignals;
}

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
  const signalsByAgentId = new Map<string, AgentReferenceSignals>();
  return {
    register(agentId) {
      return getOrCreateCardSignals(signalsByAgentId, agentId, () => {
        return createAgentReferenceSignals(agentId);
      });
    },
    resolve(agentId) {
      return registeredCardSignals(signalsByAgentId, agentId);
    },
  };
}
