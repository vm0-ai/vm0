import { command, state } from "ccstate";
import { createElement } from "react";
import { ZeroPage } from "../../views/zero-page/zero-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$, zeroSubagents$ } from "./zero-agents.ts";
import { defaultAgentName$ } from "./zero-agent-name.ts";
import { initZeroOnboarding$ } from "./zero-onboarding.ts";
import {
  initZeroActivity$,
  refreshZeroActivityIfActive$,
} from "./zero-activity.ts";
import { refreshScheduleIfActive$ } from "./zero-schedule.ts";
import { initSlackOrg$ } from "./zero-slack.ts";
import {
  zeroChatAgentName$,
  zeroInChat$,
  initSidebarCollapsed$,
} from "./zero-nav.ts";
import { switchActiveAgent$, syncUrlSession$ } from "./zero-chat.ts";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
} from "./zero-pinned-agents.ts";
import { logger } from "../log.ts";
import { pathname$ } from "../route.ts";
import { Reason, detach } from "../utils.ts";

const L = logger("ZeroPage");

/** Tracks whether the initial heavy data (agents, onboarding, slack) has loaded. */
const initialDataLoaded$ = state(false);

/**
 * Resolve the active agent from the URL and switch to it.
 *
 * - `/talk/:name` → find agent by name, switch to it
 * - `/chat/:threadId` → sync session via syncUrlSession$
 * - `/` → redirect to `/talk/:defaultAgent`
 * - other `/*` → switch to default agent
 *
 * switchActiveAgent$ sets the agent AND fetches the session list atomically.
 */
async function resolveAndSwitchAgent(
  get: Parameters<Parameters<typeof command>[0]>[0]["get"],
  set: Parameters<Parameters<typeof command>[0]>[0]["set"],
  signal: AbortSignal,
) {
  const currentPath = get(pathname$);

  // On /chat/:threadId, syncUrlSession$ switches to the correct session.
  // Don't resolve agent here — switchZeroSession$ handles that internally.
  if (get(zeroInChat$)) {
    L.info("on chat URL, syncing session");
    await set(syncUrlSession$);
    return;
  }
  L.info("resolveAgent path:", currentPath);

  // If on bare /, redirect to /talk/:defaultAgent
  if (/^\/?$/.test(currentPath)) {
    const rawName = await get(defaultAgentName$);
    signal.throwIfAborted();
    if (rawName) {
      window.history.replaceState(
        {},
        "",
        `/talk/${encodeURIComponent(rawName)}`,
      );
    }
  }

  // Resolve agent from /talk/:name
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
        // Auto-pin agent if not already pinned
        const pinned = await get(pinnedAgentIds$);
        if (!pinned.includes(agent.id)) {
          detach(
            set(updatePinnedAgentIds$, [...pinned, agent.id]),
            Reason.DomCallback,
          );
        }
      } else {
        // Unknown agent → redirect to default
        set(switchActiveAgent$, null);
        if (rawDefaultName) {
          window.history.replaceState(
            {},
            "",
            `/talk/${encodeURIComponent(rawDefaultName)}`,
          );
        }
      }
    }
  } else {
    // Non-talk, non-chat URL (e.g. /schedule)
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
      set(initSidebarCollapsed$);
      detach(set(initZeroActivity$), Reason.Daemon);
    }

    // Refresh tab-specific data on each route entry
    set(refreshZeroActivityIfActive$);
    set(refreshScheduleIfActive$);

    await resolveAndSwitchAgent(get, set, signal);
  },
);
