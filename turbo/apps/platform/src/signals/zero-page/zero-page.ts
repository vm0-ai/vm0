import { command, state } from "ccstate";
import { createElement } from "react";
import { ZeroPage } from "../../views/zero-page/zero-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$, zeroSubagents$ } from "./zero-agents.ts";
import { defaultAgentName$ } from "./zero-agent-name.ts";
import { initZeroOnboarding$ } from "./zero-onboarding.ts";
import { initZeroActivity$ } from "./zero-activity.ts";
import { initSlackOrg$ } from "./zero-slack.ts";
import { zeroChatAgentName$, zeroInChat$ } from "./zero-nav.ts";
import { switchActiveAgent$ } from "./zero-chat.ts";
import { logger } from "../log.ts";
import { pathname$ } from "../route.ts";
import { Reason, detach } from "../utils.ts";

const L = logger("ZeroPage");

/** Tracks whether the initial heavy data (agents, onboarding, slack) has loaded. */
const initialDataLoaded$ = state(false);

/**
 * Resolve the active agent from the URL and switch to it.
 *
 * - `/zero/talk/:name` → find agent by name, switch to it
 * - `/zero/chat/:threadId` → skip (switchZeroSession$ handles it)
 * - `/zero` → redirect to `/zero/talk/:defaultAgent`
 * - other `/zero/*` → switch to default agent
 *
 * switchActiveAgent$ sets the agent AND fetches the session list atomically.
 */
async function resolveAndSwitchAgent(
  get: Parameters<Parameters<typeof command>[0]>[0]["get"],
  set: Parameters<Parameters<typeof command>[0]>[0]["set"],
  signal: AbortSignal,
) {
  const currentPath = get(pathname$);

  // On /zero/chat/:threadId, switchZeroSession$ resolves the agent from
  // the thread's agentComposeId. Don't interfere here.
  if (get(zeroInChat$)) {
    L.info("on chat URL, deferring to switchZeroSession$");
    return;
  }
  L.info("resolveAgent path:", currentPath);

  // If on bare /zero, redirect to /zero/talk/:defaultAgent
  if (/^\/zero\/?$/.test(currentPath)) {
    const rawName = await get(defaultAgentName$);
    signal.throwIfAborted();
    if (rawName) {
      window.history.replaceState(
        {},
        "",
        `/zero/talk/${encodeURIComponent(rawName)}`,
      );
    }
  }

  // Resolve agent from /zero/talk/:name
  const agentName = get(zeroChatAgentName$);
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
          window.history.replaceState(
            {},
            "",
            `/zero/talk/${encodeURIComponent(rawDefaultName)}`,
          );
        }
      }
    }
  } else {
    // Non-talk, non-chat URL (e.g. /zero/schedule)
    set(switchActiveAgent$, null);
  }
}

export const setupZeroPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroPage));

    // Only fetch heavy initial data once — skip on subsequent route changes
    // (e.g. switching between talk agents).
    if (!get(initialDataLoaded$)) {
      await Promise.all([
        set(fetchAgentsList$),
        set(initZeroOnboarding$, signal),
        set(initSlackOrg$),
      ]);
      signal.throwIfAborted();
      set(initialDataLoaded$, true);
      detach(set(initZeroActivity$), Reason.Daemon);
    }

    await resolveAndSwitchAgent(get, set, signal);
  },
);
