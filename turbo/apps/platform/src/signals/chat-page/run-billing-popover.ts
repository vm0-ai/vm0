import { command, computed, state } from "ccstate";

const internalRunBillingPopoverOpenRunId$ = state<string | null>(null);

export const runBillingPopoverOpenRunId$ = computed((get) => {
  return get(internalRunBillingPopoverOpenRunId$);
});

export const setRunBillingPopoverOpenRunId$ = command(
  ({ set }, runId: string | null) => {
    set(internalRunBillingPopoverOpenRunId$, runId);
  },
);
