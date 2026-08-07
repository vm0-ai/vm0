import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { PermissionAllowPage } from "../../views/permission-allow/permission-allow-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { currentAgentId$, rememberLastUsedAgentId$ } from "../agent.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupPermissionAllowPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(PermissionAllowPage), "minimal");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.permissions.permissions;
      }),
    );

    const agentId = get(currentAgentId$);
    if (agentId) {
      set(rememberLastUsedAgentId$, agentId);
    }

    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }
  },
);
