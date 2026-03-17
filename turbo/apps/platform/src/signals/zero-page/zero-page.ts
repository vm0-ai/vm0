import { command } from "ccstate";
import { createElement } from "react";
import { ZeroPage } from "../../views/zero-page/zero-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { fetchAgentsList$, zeroSubagents$ } from "./zero-agents.ts";
import { initZeroOnboarding$ } from "./zero-onboarding.ts";
import { initZeroActivity$ } from "./zero-activity.ts";
import { initSlackOrg$ } from "./zero-slack.ts";
import { zeroChatAgentName$, setZeroChatAgent$ } from "./zero-nav.ts";
import { updatePathname$ } from "../route.ts";
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

    // Initialize chat agent from URL /zero/talk/:name
    const agentName = get(zeroChatAgentName$);
    if (agentName) {
      const subagents = await get(zeroSubagents$);
      signal.throwIfAborted();
      const agent = subagents.find((a) => a.name === agentName);
      if (agent) {
        set(setZeroChatAgent$, { id: agent.id, name: agent.name });
      } else {
        // Unknown agent name — clear agent and redirect to /zero
        set(setZeroChatAgent$, null);
        set(updatePathname$, "/zero");
      }
    } else {
      set(setZeroChatAgent$, null);
    }

    detach(set(initZeroActivity$), Reason.Daemon);
  },
);
