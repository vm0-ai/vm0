import { command } from "ccstate";
import { createElement } from "react";
import { ZeroTeamDetailPage } from "../../views/team-page/zero-team-detail-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { navigateTo$, pathParams$ } from "../route.ts";
import { agentsList$ } from "../zero-page/agents-list.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import { fetchZeroJobData$ } from "../zero-page/zero-job-detail.ts";
import {
  initZeroOnboarding$,
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
} from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";

export const setupTeamDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParams$) as { name?: string } | undefined;
    const agentName = params?.name ?? null;
    set(updatePage$, createElement(ZeroTeamDetailPage, { agentName }));
    set(updateDocumentTitle$, "Team");
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
      agentName ? set(fetchZeroJobData$, agentName) : Promise.resolve(),
    ]);
    signal.throwIfAborted();

    const needsOnboarding = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();
    const needsMemberOnboarding = await get(zeroNeedsMemberOnboarding$);
    signal.throwIfAborted();
    if (needsOnboarding || needsMemberOnboarding) {
      set(navigateTo$, "/onboarding", { replace: true });
      return;
    }

    // Update title with agent display name
    if (agentName) {
      const agents = get(agentsList$);
      const agent = agents.find((a) => a.name === agentName);
      const displayName =
        agent?.displayName ??
        agentName.charAt(0).toUpperCase() + agentName.slice(1);
      set(updateDocumentTitle$, displayName);
    }

    set(switchActiveAgent$, null);
  },
);
