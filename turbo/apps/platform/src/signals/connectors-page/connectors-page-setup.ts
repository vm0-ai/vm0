import { command } from "ccstate";
import { createElement } from "react";
import { ZeroConnectorsPageWrapper } from "../../views/connectors-page/zero-connectors-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
export const setupConnectorsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroConnectorsPageWrapper));
    set(updateDocumentTitle$, "Connectors");
    await set(initZeroOnboarding$, signal);
    signal.throwIfAborted();

    await set(onboardGuard$, signal);
  },
);
