import {
  automationEventTypeSchema,
  type WorkflowAutomationEventType,
} from "@okouai/api-contracts/contracts/workflows";
import { describe, expect, it } from "vitest";

import {
  workflowAutomationAccountConnectorSlug,
  type WorkflowAutomationAccountConnectorSlug,
} from "../workflow-automation-account-classification.service";

const expectedConnectorByEventType = {
  "chat-run-finished": null,
  "gmail-new-message": "gmail",
  "gmail-label-applied": "gmail",
  "github-deployment-status-created": null,
  "github-issue-comment-created": null,
  "github-pull-request": null,
  "github-pull-request-review-submitted": null,
  "github-workflow-job-completed": null,
  "github-workflow-run-completed": null,
  "google-calendar-event-created": "google-calendar",
  "google-calendar-event-updated": "google-calendar",
  "google-calendar-event-cancelled": "google-calendar",
  "google-forms-response-submitted": "google-forms",
  "google-meet-transcript-generated": "google-meet",
  "notion-child-page-created": "notion",
  "notion-database-item-created": "notion",
  "notion-page-content-updated": "notion",
  "stripe-invoice-paid": "stripe",
  "webhook-received": null,
} satisfies Record<
  WorkflowAutomationEventType,
  WorkflowAutomationAccountConnectorSlug | null
>;

describe("workflow automation account classification", () => {
  it("classifies every current workflow event type", () => {
    expect(Object.keys(expectedConnectorByEventType).sort()).toStrictEqual(
      [...automationEventTypeSchema.options].sort(),
    );
    for (const eventType of automationEventTypeSchema.options) {
      expect(workflowAutomationAccountConnectorSlug(eventType)).toBe(
        expectedConnectorByEventType[eventType],
      );
    }
  });

  it("does not classify absent or unknown event types as account-bound", () => {
    expect(workflowAutomationAccountConnectorSlug(null)).toBeNull();
    expect(
      workflowAutomationAccountConnectorSlug("removed-provider-event"),
    ).toBeNull();
  });
});
