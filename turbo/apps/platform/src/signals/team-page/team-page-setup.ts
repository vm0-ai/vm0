import { command } from "ccstate";
import { createElement } from "react";
import { ZeroTeamPage } from "../../views/team-page/zero-team-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";

export const setupTeamPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(ZeroTeamPage));
  set(updateDocumentTitle$, "Team");
  if (await set(onboardGuard$, signal)) {
    return;
  }

  await set(switchActiveAgent$, null, signal);
});
