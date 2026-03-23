import { command, computed } from "ccstate";
import {
  agentsList$,
  agentsLoading$,
  agentsError$,
  fetchAgentsList$,
} from "./agents-list.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import { fetch$ } from "../fetch.ts";
import { SEED_SKILLS } from "../../data/the-seed.ts";
import { createZeroAgent } from "./create-zero-agent.ts";

export { agentsLoading$, agentsError$, fetchAgentsList$ };

/**
 * Non-default agents for display in the Zero team page.
 * Filters out the default agent from the full agents list.
 */
export const zeroSubagents$ = computed(async (get) => {
  const agents = await get(agentsList$);
  const status = await get(zeroOnboardingStatus$);
  const defaultName = status.defaultAgentName;
  const defaultId = status.defaultAgentComposeId;
  return agents.filter((a) => a.name !== defaultName && a.id !== defaultId);
});

/**
 * Create a sub-agent by composing via the zero agents API.
 * Follows the same flow as onboarding: create agent → upload instructions.
 */
export const createSubagent$ = command(
  async ({ get, set }, displayName: string) => {
    const fetchFn = get(fetch$);

    await createZeroAgent(fetchFn, {
      connectors: [...SEED_SKILLS],
      displayName,
    });

    // Refresh the agents list so the new agent appears immediately
    await set(fetchAgentsList$);
  },
);
