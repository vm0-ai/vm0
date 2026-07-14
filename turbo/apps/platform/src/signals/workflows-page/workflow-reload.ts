import { command, computed, state } from "ccstate";

const internalWorkflowReload$ = state(0);

export const workflowReloadVersion$ = computed((get) => {
  return get(internalWorkflowReload$);
});

export const reloadWorkflowData$ = command(({ set }) => {
  set(internalWorkflowReload$, (previous) => {
    return previous + 1;
  });
});
