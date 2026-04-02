import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { FirewallAllowPage } from "../../views/firewall-allow/firewall-allow-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { initZeroOnboarding$ } from "../zero-page/zero-onboarding.ts";
import { reloadChatThreads$ } from "../zero-page/zero-chat.ts";
import {
  resetAdminFocusedState$,
  resetMemberFocusedState$,
  firewallAllowAgent$,
  firewallAllowRef$,
  extractPermissions,
  syncAdminListPolicies$,
} from "./firewall-allow-signals.ts";

export const setupFirewallAllowPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(SidebarLayout, null, createElement(FirewallAllowPage)),
    );
    set(updateDocumentTitle$, "Firewall Permissions");
    set(resetAdminFocusedState$);
    set(resetMemberFocusedState$);

    await set(initZeroOnboarding$, signal);
    signal.throwIfAborted();

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(reloadChatThreads$);

    const agent = await get(firewallAllowAgent$);
    signal.throwIfAborted();
    const ref = get(firewallAllowRef$);
    if (agent && ref) {
      const permissions = extractPermissions(ref);
      set(syncAdminListPolicies$, permissions, ref, agent.firewallPolicies);
    }
  },
);
