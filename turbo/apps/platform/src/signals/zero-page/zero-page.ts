import { command, state } from "ccstate";
import { createElement } from "react";
import { ZeroPage } from "../../views/zero-page/zero-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$, zeroSubagents$ } from "./zero-agents.ts";
import { defaultAgentName$ } from "./zero-agent-name.ts";
import { initZeroOnboarding$ } from "./zero-onboarding.ts";
import { initZeroActivity$ } from "./zero-activity.ts";
import { initSlackOrg$ } from "./zero-slack.ts";
import { zeroChatAgentName$, setZeroChatAgent$ } from "./zero-nav.ts";
import { fetchZeroSessionList$ } from "./zero-chat.ts";
import { pathname$ } from "../route.ts";
import { Reason, detach } from "../utils.ts";

/** Tracks whether the initial heavy data (agents, onboarding, slack) has loaded. */
const initialDataLoaded$ = state(false);

/**
 * Resolve the talk agent from the URL and fetch the session list.
 * This is the fast path — it only awaits data that's already cached
 * after the initial page load (zeroSubagents$, defaultAgentName$).
 */
async function resolveTalkAgent(
  get: Parameters<Parameters<typeof command>[0]>[0]["get"],
  set: Parameters<Parameters<typeof command>[0]>[0]["set"],
  signal: AbortSignal,
) {
  // If on bare /zero, redirect to /zero/talk/:defaultAgent
  const currentPath = get(pathname$);
  const isBareZero = /^\/zero\/?$/.test(currentPath);
  if (isBareZero) {
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

  // Initialize chat agent from URL /zero/talk/:name
  const agentName = get(zeroChatAgentName$);
  if (agentName) {
    const subagents = await get(zeroSubagents$);
    const rawDefaultName = await get(defaultAgentName$);
    signal.throwIfAborted();

    if (agentName === rawDefaultName) {
      set(setZeroChatAgent$, null);
    } else {
      const agent = subagents.find((a) => a.name === agentName);
      if (agent) {
        set(setZeroChatAgent$, { id: agent.id, name: agent.name });
      } else {
        set(setZeroChatAgent$, null);
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
    set(setZeroChatAgent$, null);
  }

  detach(set(fetchZeroSessionList$), Reason.DomCallback);
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

    await resolveTalkAgent(get, set, signal);
  },
);
