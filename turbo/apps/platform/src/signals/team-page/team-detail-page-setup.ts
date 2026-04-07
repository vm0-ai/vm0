import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroTeamDetailPage } from "../../views/team-page/zero-team-detail-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { agents$ } from "../zero-page/agents-list.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../zero-page/zero-chat.ts";
import { setActiveAgent$ } from "../zero-page/zero-job-detail.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { initSlackOrg$ } from "../zero-page/zero-slack.ts";
import { setSidebarChatAgent$ } from "../zero-page/zero-nav.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupTeamDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(SidebarLayout, null, createElement(ZeroTeamDetailPage)),
    );

    const params = get(pathParams$) as { id?: string } | undefined;
    const agentId = params?.id ?? null;
    set(updateDocumentTitle$, "Team");
    set(initSlackOrg$);
    await Promise.all([
      set(initZeroOnboarding$, signal),
      agentId ? set(setActiveAgent$, agentId) : undefined,
    ]);
    signal.throwIfAborted();
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    // Sync sidebar: show this agent's chats when viewing their profile.
    if (agentId) {
      set(setSidebarChatAgent$, agentId);
    }

    // Update title with agent display name
    if (agentId) {
      const agents = await get(agents$);
      signal.throwIfAborted();

      const agent = agents.find((a) => {
        return a.id === agentId;
      });
      const displayName = agent?.displayName ?? "Agent";
      set(updateDocumentTitle$, displayName);
    }

    set(reloadChatThreads$);
  },
);
