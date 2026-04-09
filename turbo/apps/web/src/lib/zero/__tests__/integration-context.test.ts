import { describe, it, expect } from "vitest";
import { buildIntegrationContext } from "../integration-context";

describe("buildIntegrationContext", () => {
  it("should include platform name", () => {
    const result = buildIntegrationContext("Slack");

    expect(result).toContain("# Current Integration");
    expect(result).toContain("You are currently running inside: Slack");
  });

  it("should include all slack options", () => {
    const result = buildIntegrationContext("Slack", {
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
    expect(buildIntegrationContext("Slack", { channelType: "dm" })).toContain(
      "Channel type: Direct message",
    );
    expect(
      buildIntegrationContext("Slack", { channelType: "group_dm" }),
    ).toContain("Channel type: Group direct message");
    expect(
      buildIntegrationContext("Slack", { channelType: "channel" }),
    ).toContain("Channel type: Channel");
  });

  it("should omit fields when options are not provided", () => {
    const result = buildIntegrationContext("Telegram");

    expect(result).not.toContain("bot user ID");
    expect(result).not.toContain("Channel ID");
    expect(result).not.toContain("Channel type");
    expect(result).not.toContain("Thread ID");
  });

  it("should omit thread id when undefined", () => {
    const result = buildIntegrationContext("Slack", {
      channelId: "C123",
      threadId: undefined,
    });

    expect(result).toContain("Channel ID: C123");
    expect(result).not.toContain("Thread ID");
  });

  it("should include schedule options", () => {
    const result = buildIntegrationContext("Schedule", {
      scheduleDescription: "Daily report generation",
      triggerType: "cron",
    });

    expect(result).toContain("You are currently running inside: Schedule");
    expect(result).toContain("Schedule description: Daily report generation");
    expect(result).toContain("Trigger type: cron");
  });

  it("should omit schedule fields when not provided", () => {
    const result = buildIntegrationContext("Schedule");

    expect(result).toContain("You are currently running inside: Schedule");
    expect(result).not.toContain("Schedule description");
    expect(result).not.toContain("Trigger type");
  });
});
