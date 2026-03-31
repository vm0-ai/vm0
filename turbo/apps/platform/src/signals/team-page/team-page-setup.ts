import { command } from "ccstate";
import { createElement } from "react";
import { ZeroTeamPage } from "../../views/team-page/zero-team-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { reloadChatThreads$ } from "../zero-page/zero-chat.ts";

export const setupTeamPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(ZeroTeamPage));
  set(updateDocumentTitle$, "Team");
  await set(initZeroOnboarding$, signal);
  signal.throwIfAborted();

  if (await set(onboardGuard$, signal)) {
    return;
  }

  set(reloadChatThreads$);
});
