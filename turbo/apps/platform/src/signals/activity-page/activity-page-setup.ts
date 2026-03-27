import { command } from "ccstate";
import { createElement } from "react";
import { ZeroActivityPageWrapper } from "../../views/activity-page/zero-activity-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";
import { initZeroActivity$, refreshZeroActivity$ } from "./activity-signals.ts";

export const setupActivityPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroActivityPageWrapper));
    set(updateDocumentTitle$, "Activity");
    set(refreshZeroActivity$);
    await set(initZeroActivity$, signal);
    signal.throwIfAborted();

    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(switchActiveAgent$, null, signal);
  },
);
