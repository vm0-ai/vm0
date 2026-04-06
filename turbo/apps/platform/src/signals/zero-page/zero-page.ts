import { command, state } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import { defaultAgentId$ } from "./zero-agent-name.ts";
import { zeroSubagents$ } from "./zero-agents.ts";
import { initZeroOnboarding$ } from "./zero-onboarding.ts";
import { initSlackOrg$ } from "./zero-slack.ts";

/** Tracks whether the initial heavy data (agents, onboarding) has loaded. */
const initialDataLoaded$ = state(false);

/**
 * Load agents and onboarding data once, and handle Slack URL params.
 * Shared by route setup functions (chat, talk, chat-session) so the first
 * route to execute pays the cost and subsequent navigations skip it.
 */
export const loadInitialData$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (get(initialDataLoaded$)) {
      return;
    }
    await set(initZeroOnboarding$, signal);
    signal.throwIfAborted();
    await set(initSlackOrg$, signal);
    signal.throwIfAborted();
    set(initialDataLoaded$, true);
  },
);

/**
 * Validate agent by ID and redirect to default if unknown.
 *
 * - If agentId is found among subagents or matches default, no action needed.
 * - If agentId is unknown, redirects to default agent.
 * - Agent identity is now derived via zeroChatAgentId$ computed signal.
 *
 * Used by setupTalkPage$ to handle unknown agent redirects.
 */
export const resolveAgentById$ = command(
  async ({ get, set }, agentId: string | null, signal: AbortSignal) => {
    if (!agentId) {
      return;
    }

    const subagents = await get(zeroSubagents$);
    signal.throwIfAborted();
    const rawDefaultName = await get(defaultAgentId$);
    signal.throwIfAborted();

    if (agentId === rawDefaultName) {
      return;
    }

    const agent = subagents.find((a) => {
      return a.id === agentId;
    });
    if (!agent) {
      // Unknown agent → redirect to default
      if (rawDefaultName) {
        set(detachedNavigateTo$, "/agents/:id/chat", {
          pathParams: { id: rawDefaultName },
          replace: true,
        });
      }
    }
  },
);
