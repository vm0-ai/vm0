import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { ZeroPage } from "../../views/zero-page/zero-page.tsx";
import { fetchAgentsList$ } from "./zero-agents.ts";
import { fetchZeroJobData$ } from "./zero-job-detail.ts";
import { initZeroOnboarding$ } from "./zero-onboarding.ts";

export const setupZeroJobDetailRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParams$) as { name?: string } | undefined;
    const agentName = params?.name ?? null;
    set(updatePage$, createElement(ZeroPage, { initialJobAgent: agentName }));
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
      agentName ? set(fetchZeroJobData$, agentName) : Promise.resolve(),
    ]);
  },
);
