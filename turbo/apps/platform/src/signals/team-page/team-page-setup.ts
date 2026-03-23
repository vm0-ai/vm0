import { command } from "ccstate";
import { createElement } from "react";
import { ZeroTeamPage } from "../../views/team-page/zero-team-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { navigateTo$ } from "../route.ts";
import { fetchAgentsList$ } from "../zero-page/zero-agents.ts";
import {
  initZeroOnboarding$,
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
} from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";

export const setupTeamPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroTeamPage));
    set(updateDocumentTitle$, "Team");
    await Promise.all([
      set(fetchAgentsList$),
      set(initZeroOnboarding$, signal),
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

    set(switchActiveAgent$, null);
  },
);
