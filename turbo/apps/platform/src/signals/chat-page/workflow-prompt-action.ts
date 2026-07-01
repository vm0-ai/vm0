import { command, computed, state } from "ccstate";

const replaceWorkflowPromptDraftTargetState$ = state<string | null>(null);

export const replaceWorkflowPromptDraftTarget$ = computed((get) => {
  return get(replaceWorkflowPromptDraftTargetState$);
});

export const setReplaceWorkflowPromptDraftTarget$ = command(
  ({ set }, target: string | null) => {
    set(replaceWorkflowPromptDraftTargetState$, target);
  },
);
