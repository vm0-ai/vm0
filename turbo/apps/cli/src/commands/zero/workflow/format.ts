import type { ZeroWorkflowSummary } from "@vm0/api-contracts/contracts/zero-workflows";

type WorkflowAgentFields = Pick<
  ZeroWorkflowSummary,
  "agentDisplayName" | "agentName" | "agentId"
>;

export function formatWorkflowAgentName(workflow: WorkflowAgentFields): string {
  return workflow.agentDisplayName ?? workflow.agentName ?? "-";
}
