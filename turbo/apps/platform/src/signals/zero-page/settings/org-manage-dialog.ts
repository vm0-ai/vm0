import { command, computed, state } from "ccstate";
import { reloadBillingStatus$ } from "../billing.ts";
import { initProfileName$ } from "./org-manage-tabs-state.ts";
import { searchParams$, updateSearchParams$ } from "../../route.ts";

const internalOrgManageDialogOpen$ = state(false);

export const orgManageDialogOpen$ = computed((get) => {
  return get(internalOrgManageDialogOpen$);
});

export const setOrgManageDialogOpen$ = command(
  async ({ get, set }, open: boolean, signal: AbortSignal) => {
    set(internalOrgManageDialogOpen$, open);
    if (open) {
      await set(initProfileName$, signal);
      set(reloadBillingStatus$);
    } else {
      const params = new URLSearchParams(get(searchParams$));
      if (params.has("settings") || params.has("billingView")) {
        params.delete("settings");
        params.delete("billingView");
        set(updateSearchParams$, params);
      }
    }
  },
);
