import { command, computed, state } from "ccstate";

export const CREATE_WORKFLOW_WITH_CHAT_PROMPT =
  "Help me create a workflow for this agent. Use the workflow-setup skill, then ask me for the desired outcome, automation, and action before creating the workflow and automation.";

const replaceWorkflowPromptDraftTargetState$ = state<string | null>(null);

export const replaceWorkflowPromptDraftTarget$ = computed((get) => {
  return get(replaceWorkflowPromptDraftTargetState$);
});

export const setReplaceWorkflowPromptDraftTarget$ = command(
  ({ set }, target: string | null) => {
    set(replaceWorkflowPromptDraftTargetState$, target);
  },
);
