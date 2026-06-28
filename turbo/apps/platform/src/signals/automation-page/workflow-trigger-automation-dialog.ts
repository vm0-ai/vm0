import { command, computed, state } from "ccstate";

type WorkflowAutomationDialogStep = 1 | 2;

const workflowAutomationDialogOpenState$ = state(false);
const workflowAutomationDialogStepState$ =
  state<WorkflowAutomationDialogStep>(1);
const selectedWorkflowAutomationAgentIdState$ = state("");

export const workflowAutomationDialogOpen$ = computed((get) => {
  return get(workflowAutomationDialogOpenState$);
});

export const workflowAutomationDialogStep$ = computed((get) => {
  return get(workflowAutomationDialogStepState$);
});

export const selectedWorkflowAutomationAgentId$ = computed((get) => {
  return get(selectedWorkflowAutomationAgentIdState$);
});

export const setWorkflowAutomationDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(workflowAutomationDialogOpenState$, open);
    if (open) {
      set(workflowAutomationDialogStepState$, 1);
      set(selectedWorkflowAutomationAgentIdState$, "");
    }
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
