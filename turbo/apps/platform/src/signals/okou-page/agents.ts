import { command } from "ccstate";
import { reloadAgents$ } from "../agent.ts";
import { apiClient$ } from "../api-client.ts";
import { createAgent } from "./create-agent.ts";

/**
 * Create a sub-agent by composing via the agents API.
 * Follows the same flow as onboarding: create agent → upload instructions.
 */
export const createSubagent$ = command(
  async (
    { get, set },
    displayName: string,
    avatarUrl: string,
    visibility: "public" | "private",
    signal: AbortSignal,
  ) => {
    const createClient = get(apiClient$);

    await createAgent(
      createClient,
      {
        displayName,
        avatarUrl,
        visibility,
      },
      signal,
    );
    signal.throwIfAborted();

    // Refresh the agents list so the new agent appears immediately
    set(reloadAgents$);
  },
);
