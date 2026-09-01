import { command } from "ccstate";
import { createElement } from "react";
import { AgentDetailPage } from "../../views/team-page/agent-detail-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import {
  currentAgentId$,
  agents$,
  defaultAgentId$,
  rememberLastUsedAgentId$,
} from "../agent.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { setActiveAgent$ } from "../okou-page/job-detail";
import { setChatAgentId$ } from "../agent-chat.ts";
import { i18n } from "../../i18n/index.ts";

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

    const agent = agents.find((candidate) => {
      return candidate.agentId === agentId;
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

    // Activate the agent to trigger dependent signals (detail, automation, etc.)
    set(setActiveAgent$, agentId);
    set(setChatAgentId$, agentId);
    set(rememberLastUsedAgentId$, agentId);
    const displayName =
      agent.displayName ??
      i18n.t(
        ($) => {
          return $.fallbackName;
        },
        { ns: "agents" },
      );
    set(updateDocumentTitle$, displayName);

    signal.throwIfAborted();

    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
  },
);
