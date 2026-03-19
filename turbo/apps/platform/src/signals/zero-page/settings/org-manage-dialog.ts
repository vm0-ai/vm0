import { command, computed, state } from "ccstate";
import { clerk$ } from "../../auth.ts";
import { onRef } from "../../utils.ts";

const internalOrgManageDialogOpen$ = state(false);

export const orgManageDialogOpen$ = computed((get) =>
  get(internalOrgManageDialogOpen$),
);

export const setOrgManageDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalOrgManageDialogOpen$, open);
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
      set(internalOrgManageDialogOpen$, true);
    };
    signal.addEventListener("abort", () => {
      clerk.openOrganizationProfile = original;
    });
  },
);

export const patchRef$ = onRef(patchClerkOrgProfile$);
