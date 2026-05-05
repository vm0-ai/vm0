import { command } from "ccstate";
import { reloadAgents$ } from "../agent.ts";
import { zeroClient$ } from "../api-client.ts";
import { createZeroAgent } from "./create-zero-agent.ts";

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

    await createZeroAgent(
      createClient,
      {
        displayName,
        avatarUrl,
      },
      signal,
    );
    signal.throwIfAborted();

    // Refresh the agents list so the new agent appears immediately
    set(reloadAgents$);
  },
);
