import { command } from "ccstate";
import { createElement } from "react";
import { MinimalSidebarLayout } from "../../views/zero-page/zero-directed-connect-page.tsx";
import { PermissionAllowPage } from "../../views/permission-allow/permission-allow-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import { isOrgAdmin$ } from "../org.ts";
import {
  resetFocusedState$,
  permissionAllowAgentId$,
  permissionAllowRef$,
  permissionAllowPermission$,
  permissionAllowRequestId$,
  permissionAllowReason$,
  permissionExistingRequest$,
  updateRequestIdInUrl$,
  setReason$,
} from "./permission-allow-signals.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupPermissionAllowPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(
        MinimalSidebarLayout,
        null,
        createElement(PermissionAllowPage),
      ),
    );
    set(updateDocumentTitle$, "Permissions");
    set(resetFocusedState$);

    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(reloadChatThreads$);

    // Pre-fill reason from URL parameter (set by zero doctor --reason)
    const urlReason = get(permissionAllowReason$);
    if (urlReason) {
      set(setReason$, urlReason);
    }

    // Auto-redirect: member in doctor mode with existing request → request mode
    const agentId = get(permissionAllowAgentId$);
    const ref = get(permissionAllowRef$);
    const requestId = get(permissionAllowRequestId$);
    const permission = get(permissionAllowPermission$);
    if (!requestId && permission && agentId && ref) {
      const isAdmin = await get(isOrgAdmin$);
      signal.throwIfAborted();
      if (!isAdmin) {
        const existing = await get(permissionExistingRequest$);
        signal.throwIfAborted();
        if (existing) {
          set(updateRequestIdInUrl$, existing.id);
        }
      }
    }
  },
);
