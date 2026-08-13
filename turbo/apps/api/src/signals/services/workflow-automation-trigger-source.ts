import type { ZeroWorkflowAutomationKind } from "@okouai/db/schema/zero-workflow";

export function manualTriggerSource(automation: {
  readonly kind: ZeroWorkflowAutomationKind;
}): "automation-event" | "automation-schedule" {
  return automation.kind === "event"
    ? "automation-event"
    : "automation-schedule";
}
