export const WORKFLOW_AUTOMATION_ACCOUNT_CONNECTOR_SLUGS = [
  "gmail",
  "google-calendar",
  "google-forms",
  "google-meet",
  "notion",
  "stripe",
] as const;

export type WorkflowAutomationAccountConnectorSlug =
  (typeof WORKFLOW_AUTOMATION_ACCOUNT_CONNECTOR_SLUGS)[number];

export function isWorkflowAutomationAccountConnectorSlug(
  connectorSlug: string,
): connectorSlug is WorkflowAutomationAccountConnectorSlug {
  return WORKFLOW_AUTOMATION_ACCOUNT_CONNECTOR_SLUGS.some((candidate) => {
    return candidate === connectorSlug;
  });
}

export function workflowAutomationAccountConnectorSlug(
  eventType: string | null,
): WorkflowAutomationAccountConnectorSlug | null {
  switch (eventType) {
    case "gmail-new-message":
    case "gmail-label-applied": {
      return "gmail";
    }
    case "google-calendar-event-created":
    case "google-calendar-event-updated":
    case "google-calendar-event-cancelled": {
      return "google-calendar";
    }
    case "google-forms-response-submitted": {
      return "google-forms";
    }
    case "google-meet-transcript-generated": {
      return "google-meet";
    }
    case "notion-child-page-created":
    case "notion-database-item-created":
    case "notion-page-content-updated": {
      return "notion";
    }
    case "stripe-invoice-paid": {
      return "stripe";
    }
    default: {
      return null;
    }
  }
}
