import { command, computed } from "ccstate";
import { agents$, reloadAgents$ } from "./agents-list.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import { zeroClient$ } from "../api-client.ts";
import { createZeroAgent } from "./create-zero-agent.ts";

/**
 * Non-default agents for display in the Zero team page.
 * Filters out the default agent from the full agents list.
 */
export const zeroSubagents$ = computed(async (get) => {
  const agents = await get(agents$);
  const status = await get(zeroOnboardingStatus$);
  const defaultId = status.defaultAgentId;
  return agents.filter((a) => a.id !== defaultId);
});

/**
 * Create a sub-agent by composing via the zero agents API.
 * Follows the same flow as onboarding: create agent → upload instructions.
 */
export const createSubagent$ = command(
  async (
    { get, set },
    displayName: string,
    avatarUrl: string,
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);

    await createZeroAgent(createClient, {
      connectors: [],
      displayName,
      avatarUrl,
    });
    signal.throwIfAborted();

    // Refresh the agents list so the new agent appears immediately
    set(reloadAgents$);
  },
);
