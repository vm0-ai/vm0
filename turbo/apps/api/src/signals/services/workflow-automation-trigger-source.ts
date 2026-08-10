import type { ZeroWorkflowAutomationKind } from "@vm0/db/schema/zero-workflow";

export function manualTriggerSource(automation: {
  readonly kind: ZeroWorkflowAutomationKind;
}): "automation-event" | "automation-schedule" {
  return automation.kind === "event"
    ? "automation-event"
    : "automation-schedule";
}
