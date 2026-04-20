import { command, computed, state } from "ccstate";
import { searchParams$, updateSearchParams$ } from "../../route.ts";
import { reloadBillingStatus$ } from "../billing.ts";
import { isOrgAdmin$ } from "../../org.ts";
import {
  initProfileName$,
  setActiveOrgManageTab$,
  type OrgManageTab,
} from "./org-manage-tabs-state.ts";

const internalOrgManageDialogOpen$ = state(false);

export const orgManageDialogOpen$ = computed((get) => {
  return get(internalOrgManageDialogOpen$);
});

export const setOrgManageDialogOpen$ = command(
  async ({ set }, open: boolean, signal: AbortSignal) => {
    set(internalOrgManageDialogOpen$, open);
    if (open) {
      await set(initProfileName$, signal);
      set(reloadBillingStatus$);
    }
  },
);

/**
 * Check URL for `?settings=<tab>` param and auto-open the org manage dialog
 * on the specified tab. Strips the param from the URL after consuming it.
 */
export const checkSettingsParam$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const settingsValue = params.get("settings");
    if (!settingsValue) {
      return;
    }

    const settingsTabMap: Record<string, OrgManageTab> = {
      providers: "providers",
      general: "general",
      members: "members",
      domains: "domains",
      billing: "billing",
      usage: "usage",
      credits: "usage",
      invoices: "invoices",
    };
    const ADMIN_ONLY_TABS = new Set<OrgManageTab>([
      "billing",
      "usage",
      "invoices",
      "providers",
      "domains",
    ]);
    const tab = settingsTabMap[settingsValue];
    if (tab) {
      const isAdmin = await get(isOrgAdmin$);
      signal.throwIfAborted();
      const resolvedTab =
        !isAdmin && ADMIN_ONLY_TABS.has(tab) ? "general" : tab;
      set(setActiveOrgManageTab$, resolvedTab);
      await set(setOrgManageDialogOpen$, true, signal);
    }

    // Strip the param so it doesn't re-trigger on navigation
    const next = new URLSearchParams(params);
    next.delete("settings");
    set(updateSearchParams$, next);
  },
);
