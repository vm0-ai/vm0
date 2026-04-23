import { describe, it, expect } from "vitest";
import {
  buildIntegrationPrompt,
  buildSchedulePrompt,
  buildSlackPrompt,
  buildPhonePrompt,
  buildTelegramPrompt,
  buildGitHubPrompt,
  buildWebChatPrompt,
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

  it("should not include schedule fields in base prompt", () => {
    const result = buildIntegrationPrompt("Schedule");

    expect(result).toContain("You are currently running inside: Schedule");
    expect(result).not.toContain("Schedule description");
    expect(result).not.toContain("Trigger type");
  });
});

describe("buildSchedulePrompt", () => {
  it("should include schedule header and trigger type", () => {
    const result = buildSchedulePrompt({ triggerType: "cron" });

    expect(result).toContain("You are currently running inside: Schedule");
    expect(result).toContain("Trigger type: cron");
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

describe("buildWebChatPrompt", () => {
  it("should include web integration header", () => {
    const result = buildWebChatPrompt();

    expect(result).toContain("You are currently running inside: Web");
  });

  it("should include web chat description", () => {
    const result = buildWebChatPrompt();

    expect(result).toContain("web chat UI");
    expect(result).toContain("displayed to the user directly");
  });
});
