import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { AgentDetailPage } from "../../views/team-page/zero-team-detail-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { currentAgentId$ } from "../agent.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { setActiveAgent$ } from "../zero-page/zero-job-detail.ts";

export const setupAgentDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(SidebarLayout, null, createElement(AgentDetailPage)),
    );

    const agentId = get(currentAgentId$);
    if (!agentId) {
      throw new Error(
        "Agent detail page requires an active agent, but none found",
      );
    }

    // Activate the agent to trigger dependent signals (detail, schedule, etc.)
    set(setActiveAgent$, agentId);
    set(updateDocumentTitle$, "Agent");

    if (await set(onboardGuard$, signal)) {
      return;
    }
    signal.throwIfAborted();

    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
  },
);
