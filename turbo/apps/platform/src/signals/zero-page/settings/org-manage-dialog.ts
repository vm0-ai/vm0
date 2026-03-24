import { command, computed, state } from "ccstate";
import { clerk$ } from "../../auth.ts";
import { detach, onRef, Reason } from "../../utils.ts";
import { searchParams$, updateSearchParams$ } from "../../route.ts";
import { reloadBillingStatus$ } from "../billing.ts";
import {
  initProfileName$,
  setActiveTab$,
  type OrgManageTab,
} from "./org-manage-tabs-state.ts";

const internalOrgManageDialogOpen$ = state(false);

export const orgManageDialogOpen$ = computed((get) =>
  get(internalOrgManageDialogOpen$),
);

export const setOrgManageDialogOpen$ = command(
  async ({ set }, open: boolean) => {
    if (open) {
      await set(initProfileName$);
      set(reloadBillingStatus$);
    }
    set(internalOrgManageDialogOpen$, open);
  },
);

/**
 * Check URL for `?settings=<tab>` param and auto-open the org manage dialog
 * on the specified tab. Strips the param from the URL after consuming it.
 */
export const checkSettingsParam$ = command(async ({ get, set }) => {
  const params = get(searchParams$);
  const settingsValue = params.get("settings");
  if (!settingsValue) {
    return;
  }

  const settingsTabMap: Record<string, OrgManageTab> = {
    providers: "providers",
    general: "general",
    members: "members",
    billing: "billing",
    usage: "usage",
    credits: "usage",
    invoices: "invoices",
  };
  const tab = settingsTabMap[settingsValue];
  if (tab) {
    set(setActiveTab$, tab);
    await set(setOrgManageDialogOpen$, true);
  }

  // Strip the param so it doesn't re-trigger on navigation
  const next = new URLSearchParams(params);
  next.delete("settings");
  set(updateSearchParams$, next);
});

const patchClerkOrgProfile$ = command(
  async ({ get, set }, _el: HTMLElement, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk?.openOrganizationProfile) {
      return;
    }

    const original = clerk.openOrganizationProfile.bind(clerk);
    clerk.openOrganizationProfile = () => {
      detach(set(setOrgManageDialogOpen$, true), Reason.DomCallback);
    };
    signal.addEventListener("abort", () => {
      clerk.openOrganizationProfile = original;
    });
  },
);

export const patchRef$ = onRef(patchClerkOrgProfile$);
