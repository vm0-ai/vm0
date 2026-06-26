// Shared presentational helpers for the workflow list, index, and detail views.
import type { ZeroWorkflowTriggerSummary } from "@vm0/api-contracts/contracts/zero-workflows";

export function workflowTitle(workflow: {
  readonly name: string;
  readonly displayName: string | null;
}): string {
  return workflow.displayName ?? workflow.name;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

export function agentLabel(workflow: {
  readonly agentDisplayName: string | null;
  readonly agentName: string | null;
  readonly agentId: string;
}): string {
  return workflow.agentDisplayName ?? workflow.agentName ?? workflow.agentId;
}

export function triggerKindLabel(trigger: ZeroWorkflowTriggerSummary): string {
  if (trigger.kind === "schedule") {
    return "Schedule trigger";
  }
  return trigger.eventType === "webhook-received"
    ? "Webhook trigger"
    : "Event trigger";
}
