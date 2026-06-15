import { command } from "ccstate";
import { createElement } from "react";
import { Bb0DevicePage } from "../../views/device-bb0/bb0-device-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { resetBb0Onboarding$ } from "./bb0-device-onboarding.ts";

export const setupBb0DevicePage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(resetBb0Onboarding$);
    set(updatePage$, createElement(Bb0DevicePage), "sidebar");
    set(updateDocumentTitle$, "Set up bb0");
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }
  },
);
