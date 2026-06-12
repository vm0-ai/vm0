import { command, computed, state } from "ccstate";

const internalRunUsagePopoverOpenRunId$ = state<string | null>(null);

export const runUsagePopoverOpenRunId$ = computed((get) => {
  return get(internalRunUsagePopoverOpenRunId$);
});

export const setRunUsagePopoverOpenRunId$ = command(
  ({ set }, runId: string | null) => {
    set(internalRunUsagePopoverOpenRunId$, runId);
  },
);
