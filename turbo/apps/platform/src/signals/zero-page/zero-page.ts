import { command, state } from "ccstate";
import { createElement } from "react";
import { ZeroPage } from "../../views/zero-page/zero-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$, zeroSubagents$ } from "./zero-agents.ts";
import { defaultAgentName$ } from "./zero-agent-name.ts";
import { initZeroOnboarding$ } from "./zero-onboarding.ts";
import { initZeroActivity$ } from "./zero-activity.ts";
import { initSlackOrg$ } from "./zero-slack.ts";
import {
  zeroChatAgentName$,
  setZeroChatAgent$,
  zeroInChat$,
} from "./zero-nav.ts";
import { fetchZeroSessionList$ } from "./zero-chat.ts";
import { pathname$ } from "../route.ts";
import { Reason, detach } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("ZeroPage");

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
  const currentPath = get(pathname$);
  const inChat = get(zeroInChat$);
  L.debug(`resolveTalkAgent: path=${currentPath}, inChat=${inChat}`);

  // If on bare /zero, redirect to /zero/talk/:defaultAgent
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
  L.debug(`resolveTalkAgent: agentName=${agentName}`);
  if (agentName) {
    const subagents = await get(zeroSubagents$);
    const rawDefaultName = await get(defaultAgentName$);
    signal.throwIfAborted();

    if (agentName === rawDefaultName) {
      L.debug("resolveTalkAgent: is default agent, setting null");
      set(setZeroChatAgent$, null);
    } else {
      const agent = subagents.find((a) => a.name === agentName);
      if (agent) {
        L.debug(
          `resolveTalkAgent: found subagent id=${agent.id} name=${agent.name}`,
        );
        set(setZeroChatAgent$, { id: agent.id, name: agent.name });
      } else {
        L.debug(
          `resolveTalkAgent: agent "${agentName}" not found, redirecting to default`,
        );
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
    detach(set(fetchZeroSessionList$), Reason.DomCallback);
  } else if (!inChat) {
    // Only reset agent on non-chat URLs (e.g. /zero/schedule, /zero/team).
    // On /zero/chat/:threadId, switchZeroSession$ will resolve the correct
    // agent from the thread's agentComposeId.
    L.debug("resolveTalkAgent: non-talk, non-chat URL → reset to default");
    set(setZeroChatAgent$, null);
    detach(set(fetchZeroSessionList$), Reason.DomCallback);
  } else {
    L.debug(
      "resolveTalkAgent: on chat URL, skipping agent reset (switchZeroSession$ handles it)",
    );
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

    L.debug(
      `setupZeroPage: initialDataLoaded=${get(initialDataLoaded$)}, resolving talk agent`,
    );
    await resolveTalkAgent(get, set, signal);
  },
);
