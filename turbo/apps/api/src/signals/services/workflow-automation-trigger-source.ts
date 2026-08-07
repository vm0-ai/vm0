import type { ZeroWorkflowAutomationKind } from "@vm0/db/schema/zero-workflow";

export function manualTriggerSource(automation: {
  readonly kind: ZeroWorkflowAutomationKind;
}): "workflow-event" | "workflow-schedule" {
  return automation.kind === "event" ? "workflow-event" : "workflow-schedule";
}
