import { command } from "ccstate";
import type { TeamComposeItem } from "@vm0/core";
import { createElement } from "react";
import { AgentDetailPage } from "../../views/team-page/zero-team-detail-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  currentAgentId$,
  agents$,
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

    // Activate the agent to trigger dependent signals (detail, schedule, etc.)
    set(setActiveAgent$, agentId);
    set(setChatAgentId$, agentId);
    set(rememberLastUsedAgentId$, agentId);

    // Update title with agent display name
    const agents = await get(agents$);
    signal.throwIfAborted();

    const agent = agents.find((a: TeamComposeItem) => {
      return a.id === agentId;
    });
    const displayName = agent?.displayName ?? "Agent";
    set(updateDocumentTitle$, displayName);

    if (await set(onboardGuard$, signal)) {
      return;
    }
    signal.throwIfAborted();

    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
  },
);
