import { command } from "ccstate";
import { createElement } from "react";
import { ZeroTeamDetailPage } from "../../views/team-page/zero-team-detail-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { agentsList$ } from "../zero-page/agents-list.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import { fetchZeroJobData$ } from "../zero-page/zero-job-detail.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";
import { initSlackOrg$ } from "../zero-page/zero-slack.ts";

export const setupTeamDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParams$) as { id?: string } | undefined;
    const agentId = params?.id ?? null;
    set(updatePage$, createElement(ZeroTeamDetailPage, { agentId }));
    set(updateDocumentTitle$, "Team");
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
      set(initSlackOrg$),
      agentId ? set(fetchZeroJobData$, agentId) : Promise.resolve(),
    ]);
    signal.throwIfAborted();

    if (await set(onboardGuard$, signal)) {
      return;
    }

    // Update title with agent display name
    if (agentId) {
      const agents = get(agentsList$);
      const agent = agents.find((a) => a.id === agentId);
      const displayName = agent?.displayName ?? "Agent";
      set(updateDocumentTitle$, displayName);
    }

    set(switchActiveAgent$, null);
  },
);
