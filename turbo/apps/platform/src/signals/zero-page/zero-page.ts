import { command } from "ccstate";
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

export const setupZeroPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroPage));

    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
      set(initSlackOrg$),
    ]);
    signal.throwIfAborted();

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
        // Default agent — null ID means default
        set(setZeroChatAgent$, null);
      } else {
        const agent = subagents.find((a) => a.name === agentName);
        if (agent) {
          set(setZeroChatAgent$, { id: agent.id, name: agent.name });
        } else {
          // Unknown agent name — redirect to default
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

    // Fetch session list after agent is resolved
    detach(set(fetchZeroSessionList$), Reason.DomCallback);
    detach(set(initZeroActivity$), Reason.Daemon);
  },
);
