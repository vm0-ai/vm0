import { command } from "ccstate";
import { createElement } from "react";
import { MinimalSidebarLayout } from "../../views/zero-page/zero-directed-connect-page.tsx";
import { FirewallAllowPage } from "../../views/firewall-allow/firewall-allow-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import { isOrgAdmin$ } from "../org.ts";
import {
  resetFocusedState$,
  firewallAllowAgent$,
  firewallAllowRef$,
  firewallAllowPermission$,
  firewallAllowRequestId$,
  firewallAllowReason$,
  firewallExistingRequest$,
  updateRequestIdInUrl$,
  setReason$,
} from "./firewall-allow-signals.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupFirewallAllowPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(
        MinimalSidebarLayout,
        null,
        createElement(FirewallAllowPage),
      ),
    );
    set(updateDocumentTitle$, "Firewall Permissions");
    set(resetFocusedState$);

    await set(initZeroOnboarding$, signal);
    signal.throwIfAborted();
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(reloadChatThreads$);

    const agent = await get(firewallAllowAgent$);
    signal.throwIfAborted();
    const ref = get(firewallAllowRef$);

    // Pre-fill reason from URL parameter (set by zero doctor --reason)
    const urlReason = get(firewallAllowReason$);
    if (urlReason) {
      set(setReason$, urlReason);
    }

    // Auto-redirect: member in doctor mode with existing request → request mode
    const requestId = get(firewallAllowRequestId$);
    const permission = get(firewallAllowPermission$);
    if (!requestId && permission && agent && ref) {
      const isAdmin = await get(isOrgAdmin$);
      signal.throwIfAborted();
      if (!isAdmin) {
        const existing = await get(firewallExistingRequest$);
        signal.throwIfAborted();
        if (existing) {
          set(updateRequestIdInUrl$, existing.id);
        }
      }
    }
  },
);
