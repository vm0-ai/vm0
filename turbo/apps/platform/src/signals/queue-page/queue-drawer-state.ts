import { command, computed, state } from "ccstate";

const internalQueueDrawerOpen$ = state(false);

export const queueDrawerOpen$ = computed((get) => {
  return get(internalQueueDrawerOpen$);
});

export const setQueueDrawerOpen$ = command(({ set }, open: boolean) => {
  set(internalQueueDrawerOpen$, open);
});

export const openQueueDrawer$ = command(({ set }) => {
  set(internalQueueDrawerOpen$, true);
});
