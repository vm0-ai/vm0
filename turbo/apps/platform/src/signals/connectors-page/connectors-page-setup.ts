import { command } from "ccstate";
import { createElement } from "react";
import { ZeroConnectorsPageWrapper } from "../../views/connectors-page/zero-connectors-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";

export const setupConnectorsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroConnectorsPageWrapper));
    set(updateDocumentTitle$, "Connectors");
    await set(initZeroOnboarding$, signal);
    signal.throwIfAborted();

    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(switchActiveAgent$, null, signal);
  },
);
