import { describe, it, expect } from "vitest";
import {
  buildIntegrationPrompt,
  buildVoiceChatQuickPrepPrompt,
  buildVoiceChatMeetingPrompt,
  buildSlackPrompt,
  buildPhonePrompt,
  buildTelegramPrompt,
  buildGitHubPrompt,
} from "../integration-prompt";

describe("buildIntegrationPrompt", () => {
  it("should include platform name", () => {
    const result = buildIntegrationPrompt("Slack");

    expect(result).toContain("# Current Integration");
    expect(result).toContain("You are currently running inside: Slack");
  });

  it("should include all slack options", () => {
    const result = buildIntegrationPrompt("Slack", {
      botUserId: "BBOT",
      channelId: "C123",
      channelType: "channel",
      threadId: "1234567890.001",
    });

    expect(result).toContain("Your bot user ID: BBOT");
    expect(result).toContain("Channel ID: C123");
    expect(result).toContain("Channel type: Channel");
    expect(result).toContain("Thread ID: 1234567890.001");
  });

  it("should map channel type labels", () => {
    expect(buildIntegrationPrompt("Slack", { channelType: "dm" })).toContain(
      "Channel type: Direct message",
    );
    expect(
      buildIntegrationPrompt("Slack", { channelType: "group_dm" }),
    ).toContain("Channel type: Group direct message");
    expect(
      buildIntegrationPrompt("Slack", { channelType: "channel" }),
    ).toContain("Channel type: Channel");
  });

  it("should omit fields when options are not provided", () => {
    const result = buildIntegrationPrompt("Telegram");

    expect(result).not.toContain("bot user ID");
    expect(result).not.toContain("Channel ID");
    expect(result).not.toContain("Channel type");
    expect(result).not.toContain("Thread ID");
  });

  it("should omit thread id when undefined", () => {
    const result = buildIntegrationPrompt("Slack", {
      channelId: "C123",
      threadId: undefined,
    });

    expect(result).toContain("Channel ID: C123");
    expect(result).not.toContain("Thread ID");
  });

  it("should include schedule options", () => {
    const result = buildIntegrationPrompt("Schedule", {
      scheduleDescription: "Daily report generation",
      triggerType: "cron",
    });

    expect(result).toContain("You are currently running inside: Schedule");
    expect(result).toContain("Schedule description: Daily report generation");
    expect(result).toContain("Trigger type: cron");
  });

  it("should omit schedule fields when not provided", () => {
    const result = buildIntegrationPrompt("Schedule");

    expect(result).toContain("You are currently running inside: Schedule");
    expect(result).not.toContain("Schedule description");
    expect(result).not.toContain("Trigger type");
  });
});

describe("buildVoiceChatQuickPrepPrompt", () => {
  it("should combine integration header with quick preparation prompt", () => {
    const result = buildVoiceChatQuickPrepPrompt("session-123");

    expect(result).toContain("You are currently running inside: Voice-Chat");
    expect(result).toContain("# Zero — Slow-Brain Quick Preparation Mode");
  });

  it("should replace session ID placeholder", () => {
    const result = buildVoiceChatQuickPrepPrompt("session-456");

    expect(result).toContain("context get session-456");
    expect(result).toContain("context append session-456");
    expect(result).not.toContain("<SESSION_ID>");
  });

  it("should contain preparation-ready instruction", () => {
    const result = buildVoiceChatQuickPrepPrompt("session-123");

    expect(result).toContain("preparation-ready");
  });

  it("should contain thinking and directive event instructions", () => {
    const result = buildVoiceChatQuickPrepPrompt("session-123");

    expect(result).toContain("thinking");
    expect(result).toContain("directive");
  });

  it("should contain observation mode instructions for after preparation", () => {
    const result = buildVoiceChatQuickPrepPrompt("session-123");

    expect(result).toContain("Phase 2: Live Observation");
    expect(result).toContain("session-end");
  });
});

describe("buildVoiceChatMeetingPrompt", () => {
  it("should combine integration header with meeting preparation prompt", () => {
    const result = buildVoiceChatMeetingPrompt("session-789", "Review PR #123");

    expect(result).toContain("You are currently running inside: Voice-Chat");
    expect(result).toContain("# Zero — Slow-Brain Meeting Preparation Mode");
  });

  it("should replace session ID placeholder", () => {
    const result = buildVoiceChatMeetingPrompt("session-789", "Review PR #123");

    expect(result).toContain("context get session-789");
    expect(result).toContain("context append session-789");
    expect(result).not.toContain("<SESSION_ID>");
  });

  it("should replace meeting prompt placeholder", () => {
    const result = buildVoiceChatMeetingPrompt(
      "session-789",
      "Review PR #123 before standup",
    );

    expect(result).toContain("Review PR #123 before standup");
    expect(result).not.toContain("<MEETING_PROMPT>");
  });

  it("should contain preparation-ready instruction", () => {
    const result = buildVoiceChatMeetingPrompt("session-789", "Review PR #123");

    expect(result).toContain("preparation-ready");
  });

  it("should contain thinking event instruction", () => {
    const result = buildVoiceChatMeetingPrompt("session-789", "Review PR #123");

    expect(result).toContain("thinking");
    expect(result).toContain("directive");
  });

  it("should contain observation mode instructions for after preparation", () => {
    const result = buildVoiceChatMeetingPrompt("session-789", "Review PR #123");

    expect(result).toContain("Phase 2: Live Observation");
    expect(result).toContain("session-end");
  });
});

describe("buildSlackPrompt", () => {
  it("should combine integration header with thread context", () => {
    const result = buildSlackPrompt(
      { botUserId: "BBOT", channelId: "C123", channelType: "dm" },
      "Thread history here",
    );

    expect(result).toContain("You are currently running inside: Slack");
    expect(result).toContain("Your bot user ID: BBOT");
    expect(result).toContain("Thread history here");
  });

  it("should handle empty thread context", () => {
    const result = buildSlackPrompt({ botUserId: "BBOT" }, "");

    expect(result).toContain("You are currently running inside: Slack");
    expect(result).toContain("Your bot user ID: BBOT");
  });
});

describe("buildPhonePrompt", () => {
  it("should include dm channel type and phone context", () => {
    const result = buildPhonePrompt("Caller info here");

    expect(result).toContain("You are currently running inside: Phone");
    expect(result).toContain("Channel type: Direct message");
    expect(result).toContain("Caller info here");
  });

  it("should handle empty phone context", () => {
    const result = buildPhonePrompt("");

    expect(result).toContain("You are currently running inside: Phone");
    expect(result).toContain("Channel type: Direct message");
  });
});

describe("buildTelegramPrompt", () => {
  it("should combine integration header with thread context", () => {
    const result = buildTelegramPrompt("Telegram thread here");

    expect(result).toContain("You are currently running inside: Telegram");
    expect(result).toContain("Telegram thread here");
  });

  it("should handle empty thread context", () => {
    const result = buildTelegramPrompt("");

    expect(result).toContain("You are currently running inside: Telegram");
  });
});

describe("buildGitHubPrompt", () => {
  it("should combine integration header with issue context", () => {
    const result = buildGitHubPrompt("Issue #123: Fix bug");

    expect(result).toContain("You are currently running inside: GitHub");
    expect(result).toContain("Issue #123: Fix bug");
  });

  it("should handle empty issue context", () => {
    const result = buildGitHubPrompt("");

    expect(result).toContain("You are currently running inside: GitHub");
  });
});
