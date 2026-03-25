import { command, state } from "ccstate";
import { fetchAgentsList$, zeroSubagents$ } from "./zero-agents.ts";
import { defaultAgentId$ } from "./zero-agent-name.ts";
import { initZeroOnboarding$ } from "./zero-onboarding.ts";
import { initSlackOrg$ } from "./zero-slack.ts";
import { initSidebarCollapsed$ } from "./zero-nav.ts";
import { switchActiveAgent$ } from "./zero-chat.ts";
import { navigateTo$ } from "../route.ts";

/** Tracks whether the initial heavy data (agents, onboarding, slack) has loaded. */
const initialDataLoaded$ = state(false);

/**
 * Load agents, onboarding, and slack data once.
 * Shared by route setup functions (chat, talk, chat-session) so the first
 * route to execute pays the cost and subsequent navigations skip it.
 */
export const loadInitialData$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (get(initialDataLoaded$)) {
      return;
    }
    await Promise.all([
      set(fetchAgentsList$, signal),
      set(initZeroOnboarding$, signal),
      set(initSlackOrg$, signal),
    ]);
    signal.throwIfAborted();
    set(initialDataLoaded$, true);
    set(initSidebarCollapsed$);
  },
);

/**
 * Resolve an agent by ID and switch to it, auto-pinning if needed.
 *
 * - If agentId matches the default agent, switches to null (default).
 * - If agentId is found among subagents, switches to it.
 * - If agentId is unknown, switches to null and redirects to default.
 * - If agentId is null, switches to null (no agent).
 *
 * Used by setupTalkPage$ to avoid duplicating
 * the lookup / pin / redirect logic.
 */
export const resolveAgentById$ = command(
  async ({ get, set }, agentId: string | null, signal: AbortSignal) => {
    if (agentId) {
      const subagents = await get(zeroSubagents$);
      signal.throwIfAborted();
      const rawDefaultName = await get(defaultAgentId$);
      signal.throwIfAborted();

      if (agentId === rawDefaultName) {
        await set(switchActiveAgent$, null, signal);
      } else {
        const agent = subagents.find((a) => a.id === agentId);
        if (agent) {
          await set(switchActiveAgent$, agent.id, signal);
        } else {
          // Unknown agent → redirect to default
          await set(switchActiveAgent$, null, signal);
          if (rawDefaultName) {
            set(navigateTo$, "/talk/:id", {
              pathParams: { id: rawDefaultName },
              replace: true,
            });
          }
        }
      }
    } else {
      await set(switchActiveAgent$, null, signal);
    }
  },
);
