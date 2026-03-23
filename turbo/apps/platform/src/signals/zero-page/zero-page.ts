import { command, state, type Getter, type Setter } from "ccstate";
import { fetchAgentsList$, zeroSubagents$ } from "./zero-agents.ts";
import { defaultAgentName$ } from "./zero-agent-name.ts";
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
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
      set(initSlackOrg$),
    ]);
    signal.throwIfAborted();
    set(initialDataLoaded$, true);
    set(initSidebarCollapsed$);
  },
);

/**
 * Resolve an agent by name and switch to it, auto-pinning if needed.
 *
 * - If agentName matches the default agent, switches to null (default).
 * - If agentName is found among subagents, switches to it.
 * - If agentName is unknown, switches to null and redirects to default.
 * - If agentName is null, switches to null (no agent).
 *
 * Used by setupTalkPage$ to avoid duplicating
 * the lookup / pin / redirect logic.
 */
export async function resolveAgentByName(
  get: Getter,
  set: Setter,
  signal: AbortSignal,
  agentName: string | null,
): Promise<void> {
  if (agentName) {
    const subagents = await get(zeroSubagents$);
    const rawDefaultName = await get(defaultAgentName$);
    signal.throwIfAborted();

    if (agentName === rawDefaultName) {
      set(switchActiveAgent$, null);
    } else {
      const agent = subagents.find((a) => a.name === agentName);
      if (agent) {
        set(switchActiveAgent$, { id: agent.id, name: agent.name });
      } else {
        // Unknown agent → redirect to default
        set(switchActiveAgent$, null);
        if (rawDefaultName) {
          set(navigateTo$, "/talk/:name", {
            pathParams: { name: rawDefaultName },
            replace: true,
          });
        }
      }
    }
  } else {
    set(switchActiveAgent$, null);
  }
}
