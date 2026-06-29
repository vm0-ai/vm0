import { command, computed, state } from "ccstate";

type WorkflowAutomationDialogStep = 1 | 2;

const workflowAutomationDialogOpenState$ = state(false);
const workflowAutomationDialogStepState$ =
  state<WorkflowAutomationDialogStep>(1);
const selectedWorkflowAutomationAgentIdState$ = state("");
const workflowAutomationAgentQueryState$ = state("");
const workflowAutomationAgentSelectionLockedState$ = state(false);

export const workflowAutomationDialogOpen$ = computed((get) => {
  return get(workflowAutomationDialogOpenState$);
});

export const workflowAutomationDialogStep$ = computed((get) => {
  return get(workflowAutomationDialogStepState$);
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

export const setWorkflowAutomationDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(workflowAutomationDialogOpenState$, open);
    if (open) {
      set(workflowAutomationDialogStepState$, 1);
      set(selectedWorkflowAutomationAgentIdState$, "");
      set(workflowAutomationAgentQueryState$, "");
      set(workflowAutomationAgentSelectionLockedState$, false);
    }
  },
);

export const openWorkflowAutomationDialogForAgent$ = command(
  ({ set }, agentId: string) => {
    set(workflowAutomationDialogOpenState$, true);
    set(workflowAutomationDialogStepState$, 2);
    set(selectedWorkflowAutomationAgentIdState$, agentId);
    set(workflowAutomationAgentQueryState$, "");
    set(workflowAutomationAgentSelectionLockedState$, true);
  },
);

export const setWorkflowAutomationDialogStep$ = command(
  ({ set }, step: WorkflowAutomationDialogStep) => {
    set(workflowAutomationDialogStepState$, step);
  },
);

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
