import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { PermissionAllowPage } from "../../views/permission-allow/permission-allow-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { initialFeatureSwitchHydration$ } from "../external/feature-switch.ts";

export const setupPermissionAllowPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await get(initialFeatureSwitchHydration$);
    signal.throwIfAborted();

    set(updatePage$, createElement(PermissionAllowPage), "minimal");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.permissions.permissions;
      }),
    );

    await set(hideAppSkeleton$, signal);
  },
);
