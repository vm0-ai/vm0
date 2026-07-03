import { describe, expect, it } from "vitest";

import {
  googleCalendarEventCancelledEventConfigSchema,
  googleCalendarEventCreatedEventConfigSchema,
  googleCalendarEventUpdatedEventConfigSchema,
  googleMeetTranscriptGeneratedEventConfigSchema,
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

describe("Google Calendar event-created workflow trigger contract", () => {
  it("defaults to the primary calendar", () => {
    const parsed = googleCalendarEventCreatedEventConfigSchema.parse({
      provider: "google-calendar",
      event: "event_created",
    });

    expect(parsed).toStrictEqual({
      provider: "google-calendar",
      event: "event_created",
      calendarId: "primary",
    });
  });

  it("accepts event-created trigger create requests without explicit config", () => {
    const parsed = zeroWorkflowTriggerCreateRequestSchema.parse({
      kind: "event",
      eventType: "google-calendar-event-created",
    });

    expect(parsed).toStrictEqual({
      kind: "event",
      eventType: "google-calendar-event-created",
      eventConfig: {
        provider: "google-calendar",
        event: "event_created",
        calendarId: "primary",
      },
    });
  });
});

describe("Google Calendar event-updated workflow trigger contract", () => {
  it("defaults to the primary calendar", () => {
    const parsed = googleCalendarEventUpdatedEventConfigSchema.parse({
      provider: "google-calendar",
      event: "event_updated",
    });

    expect(parsed).toStrictEqual({
      provider: "google-calendar",
      event: "event_updated",
      calendarId: "primary",
    });
  });

  it("accepts event-updated trigger create requests without explicit config", () => {
    const parsed = zeroWorkflowTriggerCreateRequestSchema.parse({
      kind: "event",
      eventType: "google-calendar-event-updated",
    });

    expect(parsed).toStrictEqual({
      kind: "event",
      eventType: "google-calendar-event-updated",
      eventConfig: {
        provider: "google-calendar",
        event: "event_updated",
        calendarId: "primary",
      },
    });
  });
});

describe("Google Calendar event-cancelled workflow trigger contract", () => {
  it("defaults to the primary calendar", () => {
    const parsed = googleCalendarEventCancelledEventConfigSchema.parse({
      provider: "google-calendar",
      event: "event_cancelled",
    });

    expect(parsed).toStrictEqual({
      provider: "google-calendar",
      event: "event_cancelled",
      calendarId: "primary",
    });
  });

  it("accepts event-cancelled trigger create requests without explicit config", () => {
    const parsed = zeroWorkflowTriggerCreateRequestSchema.parse({
      kind: "event",
      eventType: "google-calendar-event-cancelled",
    });

    expect(parsed).toStrictEqual({
      kind: "event",
      eventType: "google-calendar-event-cancelled",
      eventConfig: {
        provider: "google-calendar",
        event: "event_cancelled",
        calendarId: "primary",
      },
    });
  });
});

describe("Google Meet transcript-generated workflow trigger contract", () => {
  it("defaults to organizer-user scope", () => {
    const parsed = googleMeetTranscriptGeneratedEventConfigSchema.parse({
      provider: "google-meet",
      event: "transcript_generated",
    });

    expect(parsed).toStrictEqual({
      provider: "google-meet",
      event: "transcript_generated",
      scope: { type: "organizer_user" },
    });
  });

  it("accepts transcript-generated trigger create requests without explicit config", () => {
    const parsed = zeroWorkflowTriggerCreateRequestSchema.parse({
      kind: "event",
      eventType: "google-meet-transcript-generated",
    });

    expect(parsed).toStrictEqual({
      kind: "event",
      eventType: "google-meet-transcript-generated",
      eventConfig: {
        provider: "google-meet",
        event: "transcript_generated",
        scope: { type: "organizer_user" },
      },
    });
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
