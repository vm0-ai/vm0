import { command, computed, state } from "ccstate";
import { reloadBillingStatus$ } from "../billing.ts";
import { initProfileName$ } from "./org-manage-tabs-state.ts";

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
