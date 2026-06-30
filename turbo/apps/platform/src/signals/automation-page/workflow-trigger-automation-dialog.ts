import { command, computed, state } from "ccstate";

export type WorkflowAutomationDialogIntent =
  | "automation"
  | "automation-chat"
  | "workflow";

const workflowAutomationDialogOpenState$ = state(false);
const selectedWorkflowAutomationAgentIdState$ = state("");
const workflowAutomationAgentQueryState$ = state("");
const workflowAutomationAgentSelectionLockedState$ = state(false);
const workflowAutomationDialogIntentState$ =
  state<WorkflowAutomationDialogIntent>("automation");

export const workflowAutomationDialogOpen$ = computed((get) => {
  return get(workflowAutomationDialogOpenState$);
});

export const selectedWorkflowAutomationAgentId$ = computed((get) => {
  return get(selectedWorkflowAutomationAgentIdState$);
});

export const workflowAutomationAgentQuery$ = computed((get) => {
  return get(workflowAutomationAgentQueryState$);
});

export const workflowAutomationAgentSelectionLocked$ = computed((get) => {
  return get(workflowAutomationAgentSelectionLockedState$);
});

export const workflowAutomationDialogIntent$ = computed((get) => {
  return get(workflowAutomationDialogIntentState$);
});

export const setWorkflowAutomationDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(workflowAutomationDialogOpenState$, open);
    if (open) {
      set(selectedWorkflowAutomationAgentIdState$, "");
      set(workflowAutomationAgentQueryState$, "");
      set(workflowAutomationAgentSelectionLockedState$, false);
      set(workflowAutomationDialogIntentState$, "automation");
    }
  },
);

export const openCreateWorkflowDialog$ = command(({ set }) => {
  set(workflowAutomationDialogOpenState$, true);
  set(selectedWorkflowAutomationAgentIdState$, "");
  set(workflowAutomationAgentQueryState$, "");
  set(workflowAutomationAgentSelectionLockedState$, false);
  set(workflowAutomationDialogIntentState$, "workflow");
});

export const openWorkflowAutomationDialogForAgent$ = command(
  ({ set }, agentId: string) => {
    set(workflowAutomationDialogOpenState$, true);
    set(selectedWorkflowAutomationAgentIdState$, agentId);
    set(workflowAutomationAgentQueryState$, "");
    set(workflowAutomationAgentSelectionLockedState$, true);
    set(workflowAutomationDialogIntentState$, "automation-chat");
  },
);

export const startCreateWorkflowFromAutomationDialog$ = command(({ set }) => {
  set(selectedWorkflowAutomationAgentIdState$, "");
  set(workflowAutomationAgentQueryState$, "");
  set(workflowAutomationAgentSelectionLockedState$, false);
  set(workflowAutomationDialogIntentState$, "automation-chat");
});

export const setSelectedWorkflowAutomationAgentId$ = command(
  ({ set }, agentId: string) => {
    set(selectedWorkflowAutomationAgentIdState$, agentId);
  },
);

export const setWorkflowAutomationAgentQuery$ = command(
  ({ set }, query: string) => {
    set(workflowAutomationAgentQueryState$, query);
  },
);
