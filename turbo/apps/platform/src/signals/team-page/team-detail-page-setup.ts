import { command } from "ccstate";
import { createElement } from "react";
import { ZeroTeamDetailPage } from "../../views/team-page/zero-team-detail-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { agents$ } from "../zero-page/agents-list.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { fetchZeroSessionList$ } from "../zero-page/zero-chat.ts";
import { fetchZeroJobData$ } from "../zero-page/zero-job-detail.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { initSlackOrg$ } from "../zero-page/zero-slack.ts";
import { setSidebarChatAgent$ } from "../zero-page/zero-nav.ts";

export const setupTeamDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroTeamDetailPage));

    const params = get(pathParams$) as { agentId?: string } | undefined;
    const agentId = params?.agentId ?? null;
    set(updateDocumentTitle$, "Team");
    await Promise.all([
      set(initZeroOnboarding$, signal),
      set(initSlackOrg$, signal),
      agentId ? set(fetchZeroJobData$, agentId, signal) : Promise.resolve(),
    ]);
    signal.throwIfAborted();

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

      const agent = agents.find((a) => a.id === agentId);
      const displayName = agent?.displayName ?? "Agent";
      set(updateDocumentTitle$, displayName);
    }

    await set(fetchZeroSessionList$, signal);
  },
);
