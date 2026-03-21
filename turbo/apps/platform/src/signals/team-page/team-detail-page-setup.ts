import { command } from "ccstate";
import { createElement } from "react";
import { ZeroTeamDetailPage } from "../../views/team-page/zero-team-detail-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import { fetchZeroJobData$ } from "../zero-page/zero-job-detail.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";

export const setupTeamDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParams$) as { name?: string } | undefined;
    const agentName = params?.name ?? null;
    set(updatePage$, createElement(ZeroTeamDetailPage, { agentName }));
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
      agentName ? set(fetchZeroJobData$, agentName) : Promise.resolve(),
    ]);
    signal.throwIfAborted();
    set(switchActiveAgent$, null);
  },
);
