import { describe, expect, it } from "vitest";

import { buildGmailWorkflowTriggerBrief } from "../gmail-workflow-event.service";

describe("buildGmailWorkflowTriggerBrief", () => {
  it("includes sender and subject for new-message events", () => {
    expect(
      buildGmailWorkflowTriggerBrief({
        triggerConfig: {
          provider: "gmail",
          event: "new_message",
        },
        message: {
          messageId: "msg-1",
          threadId: "gmail-thread-1",
          from: "Customer Example <customer@example.com>",
          subject: "Invoice needs a reply",
        },
      }),
    ).toBe(
      [
        "Gmail new message",
        "From: Customer Example <customer@example.com>",
        "Subject: Invoice needs a reply",
      ].join("\n"),
    );
  });

  it("includes the label name and stable fallbacks for labeled events", () => {
    expect(
      buildGmailWorkflowTriggerBrief({
        triggerConfig: {
          provider: "gmail",
          event: "label_applied",
          labelName: "Support",
        },
        message: {
          messageId: "msg-labeled",
          threadId: null,
          from: null,
          subject: null,
        },
      }),
    ).toBe(
      [
        "Gmail label applied: Support",
        "From: Unknown sender",
        "Subject: (no subject)",
      ].join("\n"),
    );
  });
});
