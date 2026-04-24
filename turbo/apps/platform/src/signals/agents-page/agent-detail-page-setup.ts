import { command } from "ccstate";
import type { TeamComposeItem } from "@vm0/core";
import { createElement } from "react";
import { AgentDetailPage } from "../../views/team-page/zero-team-detail-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import {
  currentAgentId$,
  agents$,
  defaultAgentId$,
  rememberLastUsedAgentId$,
} from "../agent.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { setActiveAgent$ } from "../zero-page/zero-job-detail.ts";
import { setChatAgentId$ } from "../agent-chat.ts";

export const setupAgentDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(AgentDetailPage), "sidebar");

    const agentId = get(currentAgentId$);
    if (!agentId) {
      throw new Error(
        "Agent detail page requires an active agent, but none found",
      );
    }

    const agents = await get(agents$);
    signal.throwIfAborted();

    const agent = agents.find((a: TeamComposeItem) => {
      return a.id === agentId;
    });
    if (!agent) {
      const defaultAgentId = await get(defaultAgentId$);
      signal.throwIfAborted();
      if (!defaultAgentId || defaultAgentId === agentId) {
        throw new Error(
          "Agent detail page requires an active agent, but none found",
        );
      }
      set(detachedNavigateTo$, "/agents/:agentId", {
        pathParams: { agentId: defaultAgentId },
        searchParams: get(searchParams$),
        replace: true,
      });
      return;
    }

    // Activate the agent to trigger dependent signals (detail, schedule, etc.)
    set(setActiveAgent$, agentId);
    set(setChatAgentId$, agentId);
    set(rememberLastUsedAgentId$, agentId);

    const displayName = agent.displayName ?? "Agent";
    set(updateDocumentTitle$, displayName);

    if (await set(onboardGuard$, signal)) {
      return;
    }
    signal.throwIfAborted();

    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
  },
);
