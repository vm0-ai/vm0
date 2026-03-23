import { command } from "ccstate";
import { createElement } from "react";
import { ZeroTalkPageWrapper } from "../../views/zero-page/zero-talk-page-wrapper.tsx";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { zeroSubagents$ } from "./zero-agents.ts";
import { defaultAgentName$ } from "./zero-agent-name.ts";
import { switchActiveAgent$ } from "./zero-chat.ts";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
} from "./zero-pinned-agents.ts";
import { syncModelPreference$ } from "./zero-model-preference.ts";
import { logger } from "../log.ts";
import { Reason, detach } from "../utils.ts";
import { loadInitialData$ } from "./zero-page.ts";

const L = logger("TalkPage");

export const setupTalkPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroTalkPageWrapper));

    await set(loadInitialData$, signal);

    // Resolve agent from /talk/:name
    const params = get(pathParams$) as { name?: string } | undefined;
    const agentName = params?.name ?? null;
    L.info("resolveAgent talk:", agentName);

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
      set(switchActiveAgent$, null);
    }

    set(syncModelPreference$);
  },
);
