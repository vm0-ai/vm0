import { command } from "ccstate";
import { createElement } from "react";
import { PermissionAllowPage } from "../../views/permission-allow/permission-allow-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { currentAgentId$, rememberLastUsedAgentId$ } from "../agent.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import { user$ } from "../auth.ts";
import { isOrgAdmin$ } from "../org.ts";
import {
  resetFocusedState$,
  permissionAllowAgentId$,
  permissionAllowAgent$,
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
    set(updatePage$, createElement(PermissionAllowPage), "minimal");
    set(updateDocumentTitle$, "Permissions");
    set(resetFocusedState$);

    const agentId = get(currentAgentId$);
    if (agentId) {
      set(rememberLastUsedAgentId$, agentId);
    }

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

    // Auto-redirect: requester in doctor mode with existing request → request mode
    const permissionAgentId = get(permissionAllowAgentId$);
    const ref = get(permissionAllowRef$);
    const requestId = get(permissionAllowRequestId$);
    const permission = get(permissionAllowPermission$);
    if (!requestId && permission && permissionAgentId && ref) {
      const [isAdmin, currentUser, agent] = await Promise.all([
        get(isOrgAdmin$),
        get(user$),
        get(permissionAllowAgent$),
      ]);
      signal.throwIfAborted();
      if (!isAdmin && currentUser?.id !== agent?.ownerId) {
        const existing = await get(permissionExistingRequest$);
        signal.throwIfAborted();
        if (existing) {
          set(updateRequestIdInUrl$, existing.id);
        }
      }
    }
  },
);
