import { describe, expect, it } from "vitest";

import {
  googleCalendarEventCancelledEventConfigSchema,
  googleCalendarEventCreatedEventConfigSchema,
  googleCalendarEventUpdatedEventConfigSchema,
  googleMeetTranscriptGeneratedEventConfigSchema,
  gmailLabelAppliedEventConfigSchema,
  gmailNewMessageEventConfigSchema,
  slackUserMentionedEventConfigSchema,
  chatThreadWorkflowAutomationSchema,
  zeroWorkflowConnectorReadinessResponseSchema,
  zeroWorkflowUpdateRequestSchema,
  zeroWorkflowAutomationCreateRequestSchema,
  zeroWorkflowAutomationSummarySchema,
  zeroWorkflowAutomationUpdateRequestSchema,
} from "../zero-workflows";

describe("Slack user-mentioned workflow automation contract", () => {
  const persistedEventConfig = {
    provider: "slack",
    event: "user_mentioned",
    channel: { id: "C0123456789", name: "product" },
  } as const;

  it("keeps create input separate from persisted channel metadata", () => {
    expect(
      zeroWorkflowAutomationCreateRequestSchema.parse({
        kind: "event",
        eventType: "slack-user-mentioned",
        eventConfig: {
          provider: "slack",
          event: "user_mentioned",
          channel: "#product",
        },
      }),
    ).toStrictEqual({
      kind: "event",
      eventType: "slack-user-mentioned",
      eventConfig: {
        provider: "slack",
        event: "user_mentioned",
        channel: "#product",
      },
    });
    expect(
      zeroWorkflowAutomationCreateRequestSchema.safeParse({
        kind: "event",
        eventType: "slack-user-mentioned",
        eventConfig: persistedEventConfig,
      }).success,
    ).toBe(false);
    expect(
      zeroWorkflowAutomationCreateRequestSchema.safeParse({
        kind: "event",
        eventType: "slack-user-mentioned",
        eventConfig: {
          provider: "slack",
          event: "user_mentioned",
          channel: "product",
          mentionedUserId: "U0123456789",
        },
      }).success,
    ).toBe(false);
  });

  it("requires resolved channel metadata for persisted configs", () => {
    expect(
      slackUserMentionedEventConfigSchema.parse(persistedEventConfig),
    ).toStrictEqual(persistedEventConfig);
    expect(
      slackUserMentionedEventConfigSchema.safeParse({
        provider: "slack",
        event: "user_mentioned",
        channel: "product",
      }).success,
    ).toBe(false);
  });

  it("accepts only raw channel selectors on update", () => {
    expect(
      zeroWorkflowAutomationUpdateRequestSchema.safeParse({
        eventConfig: {
          provider: "slack",
          event: "user_mentioned",
          channel: "C0123456789",
        },
      }).success,
    ).toBe(true);
    expect(
      zeroWorkflowAutomationUpdateRequestSchema.safeParse({
        eventConfig: persistedEventConfig,
      }).success,
    ).toBe(false);
  });

  it("exposes resolved channel metadata in detail and chat summaries", () => {
    const summary = {
      id: "automation-1",
      ownerUserId: "user-1",
      enabled: true,
      chatThreadId: "thread-1",
      nextRunAt: null,
      lastRunAt: null,
      kind: "event",
      eventType: "slack-user-mentioned",
      eventConfig: persistedEventConfig,
      schedule: null,
      scheduleSummary: null,
    } as const;
    expect(zeroWorkflowAutomationSummarySchema.safeParse(summary).success).toBe(
      true,
    );
    expect(
      chatThreadWorkflowAutomationSchema.safeParse({
        ...summary,
        id: "00000000-0000-4000-a000-000000000001",
        workflow: {
          id: "00000000-0000-4000-a000-000000000002",
          agentId: "00000000-0000-4000-a000-000000000003",
          name: "slack-mention",
          displayName: "Slack mention",
          description: null,
        },
      }).success,
    ).toBe(true);
  });
});

describe("Gmail new message workflow automation contract", () => {
  it("accepts only explicit text match fields", () => {
    const parsed = gmailNewMessageEventConfigSchema.safeParse({
      provider: "gmail",
      event: "new_message",
      threadId: "gmail-thread-1",
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

describe("Gmail label applied workflow automation contract", () => {
  it("accepts a label name and optional resolved label id", () => {
    const parsed = gmailLabelAppliedEventConfigSchema.safeParse({
      provider: "gmail",
      event: "label_applied",
      labelName: "Support",
      resolvedLabelId: "Label_123",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts label applied automation create requests", () => {
    const parsed = zeroWorkflowAutomationCreateRequestSchema.safeParse({
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

describe("Google Calendar event-created workflow automation contract", () => {
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

  it("accepts event-created automation create requests without explicit config", () => {
    const parsed = zeroWorkflowAutomationCreateRequestSchema.parse({
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

describe("Google Calendar event-updated workflow automation contract", () => {
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

  it("accepts event-updated automation create requests without explicit config", () => {
    const parsed = zeroWorkflowAutomationCreateRequestSchema.parse({
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

describe("Google Calendar event-cancelled workflow automation contract", () => {
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

  it("accepts event-cancelled automation create requests without explicit config", () => {
    const parsed = zeroWorkflowAutomationCreateRequestSchema.parse({
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

describe("Google Meet transcript-generated workflow automation contract", () => {
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

  it("accepts transcript-generated automation create requests without explicit config", () => {
    const parsed = zeroWorkflowAutomationCreateRequestSchema.parse({
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

describe("workflow connector readiness contract", () => {
  it("accepts all readiness states without limiting the connector count", () => {
    const entries = [
      { connectorSlug: "github", status: "connected" },
      { connectorSlug: "gmail", status: "not-connected" },
      { connectorSlug: "notion", status: "scope-mismatch" },
      { connectorSlug: "slack", status: "reconnect-required" },
      { connectorSlug: "linear", status: "not-enabled-for-agent" },
      { connectorSlug: "google-drive", status: "unavailable" },
    ] as const;

    const parsed = zeroWorkflowConnectorReadinessResponseSchema.parse({
      connectors: entries.map((entry, index) => {
        return {
          connectorSlug: entry.connectorSlug,
          label: `Connector ${index}`,
          icon: {
            url: `https://icons.example.test/${entry.connectorSlug}.svg`,
            invertInDarkMode: false,
          },
          reason: "The workflow uses this service.",
          status: entry.status,
        };
      }),
    });

    expect(parsed.connectors).toHaveLength(entries.length);
  });

  it("rejects unknown readiness states", () => {
    expect(
      zeroWorkflowConnectorReadinessResponseSchema.safeParse({
        connectors: [
          {
            connectorSlug: "github",
            label: "GitHub",
            reason: "The workflow reads issues.",
            status: "unknown",
            confidence: 0.9,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
