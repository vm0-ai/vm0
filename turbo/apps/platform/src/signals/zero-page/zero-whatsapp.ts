import { command, computed, state } from "ccstate";

const internalConnectDialogOpen$ = state(false);

export const whatsAppConnectDialogOpen$ = computed((get) => {
  return get(internalConnectDialogOpen$);
});

export const setWhatsAppConnectDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalConnectDialogOpen$, open);
  },
);
