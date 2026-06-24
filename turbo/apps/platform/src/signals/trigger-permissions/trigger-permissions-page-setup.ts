import { command } from "ccstate";
import { createElement } from "react";
import { TriggerPermissionsPage } from "../../views/trigger-permissions/trigger-permissions-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";

export const setupTriggerPermissionsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(TriggerPermissionsPage), "sidebar");
    set(updateDocumentTitle$, "Trigger Permissions");

    await set(hideAppSkeleton$, signal);

    await set(onboardGuard$, signal);
  },
);
