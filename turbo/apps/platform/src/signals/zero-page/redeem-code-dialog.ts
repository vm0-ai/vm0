import { command, computed, state } from "ccstate";

const internalOpen$ = state(false);
const internalCode$ = state("");

export const redeemCodeDialogOpen$ = computed((get) => {
  return get(internalOpen$);
});

export const redeemCodeInput$ = computed((get) => {
  return get(internalCode$);
});

export const setRedeemCodeDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalOpen$, open);
  if (!open) {
    set(internalCode$, "");
  }
});

export const setRedeemCodeInput$ = command(({ set }, value: string) => {
  set(internalCode$, value);
});
