import type { WorkflowSummary } from "@okouai/api-contracts/contracts/workflows";

type WorkflowAgentFields = Pick<
  WorkflowSummary,
  "agentDisplayName" | "agentName" | "agentId"
>;

export function formatWorkflowAgentName(workflow: WorkflowAgentFields): string {
  return workflow.agentDisplayName ?? workflow.agentName ?? "-";
}
