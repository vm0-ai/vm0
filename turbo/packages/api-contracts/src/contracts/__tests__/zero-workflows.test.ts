import { describe, expect, it } from "vitest";

import {
  gmailLabelAppliedEventConfigSchema,
  gmailNewMessageEventConfigSchema,
  zeroWorkflowUpdateRequestSchema,
  zeroWorkflowTriggerCreateRequestSchema,
} from "../zero-workflows";

describe("Gmail new message workflow trigger contract", () => {
  it("accepts only explicit text match fields", () => {
    const parsed = gmailNewMessageEventConfigSchema.safeParse({
      provider: "gmail",
      event: "new_message",
      match: {
        from: { contains: "@example.com" },
        to: { containsAny: ["team@example.com"] },
        cc: { doesNotContain: "archive@example.com" },
        subject: { doesNotContainAny: ["newsletter"] },
        body: { contains: "invoice" },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects removed match fields", () => {
    const removedMatchRules = [
      { snippet: { contains: "preview" } },
      { labels: { includeAny: ["INBOX"] } },
      { hasAttachment: true },
    ];

    for (const match of removedMatchRules) {
      const parsed = gmailNewMessageEventConfigSchema.safeParse({
        provider: "gmail",
        event: "new_message",
        match,
      });

      expect(parsed.success).toBe(false);
    }
  });
});

describe("Gmail label applied workflow trigger contract", () => {
  it("accepts a label name and optional resolved label id", () => {
    const parsed = gmailLabelAppliedEventConfigSchema.safeParse({
      provider: "gmail",
      event: "label_applied",
      labelName: "Support",
      resolvedLabelId: "Label_123",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts label applied trigger create requests", () => {
    const parsed = zeroWorkflowTriggerCreateRequestSchema.safeParse({
      kind: "event",
      eventType: "gmail-label-applied",
      eventConfig: {
        provider: "gmail",
        event: "label_applied",
        labelName: "Support",
      },
    });

    expect(parsed.success).toBe(true);
  });
});

describe("workflow update contract", () => {
  it("accepts slug metadata updates", () => {
    const parsed = zeroWorkflowUpdateRequestSchema.safeParse({
      name: "follow-up",
      displayName: "Follow up",
      description: "Use when a prospect needs a next step.",
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects invalid workflow slugs", () => {
    const parsed = zeroWorkflowUpdateRequestSchema.safeParse({
      name: "Follow Up",
    });

    expect(parsed.success).toBe(false);
  });
});
