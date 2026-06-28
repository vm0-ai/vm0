import { command, computed, state } from "ccstate";

type WorkflowAutomationDialogStep = 1 | 2;

const workflowAutomationDialogOpenState$ = state(false);
const workflowAutomationDialogStepState$ =
  state<WorkflowAutomationDialogStep>(1);
const selectedWorkflowAutomationAgentIdState$ = state("");
const workflowAutomationAgentQueryState$ = state("");

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

export const setWorkflowAutomationDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(workflowAutomationDialogOpenState$, open);
    if (open) {
      set(workflowAutomationDialogStepState$, 1);
      set(selectedWorkflowAutomationAgentIdState$, "");
      set(workflowAutomationAgentQueryState$, "");
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

export const setWorkflowAutomationAgentQuery$ = command(
  ({ set }, query: string) => {
    set(workflowAutomationAgentQueryState$, query);
  },
);
