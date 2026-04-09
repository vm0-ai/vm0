import { describe, it, expect } from "vitest";
import { buildIntegrationContext, buildUserInfo } from "../integration-context";

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

describe("buildUserInfo", () => {
  it("should include all base fields", () => {
    const result = buildUserInfo({
      name: "Alice",
      email: "alice@example.com",
      timezone: "Asia/Shanghai",
    });

    expect(result).toContain("# Current User Info");
    expect(result).toContain("Name: Alice");
    expect(result).toContain("Email: alice@example.com");
    expect(result).toContain("Timezone: Asia/Shanghai");
  });

  it("should include slack-specific fields", () => {
    const result = buildUserInfo({
      name: "Alice",
      email: "alice@example.com",
      timezone: "America/New_York",
      slackDisplayName: "alice.slack",
      slackUserId: "U12345",
    });

    expect(result).toContain("Slack display name: alice.slack");
    expect(result).toContain("Slack user ID: U12345");
  });

  it("should omit undefined fields", () => {
    const result = buildUserInfo({
      email: "bob@example.com",
      timezone: "UTC",
    });

    expect(result).toContain("Email: bob@example.com");
    expect(result).toContain("Timezone: UTC");
    expect(result).not.toContain("Name:");
    expect(result).not.toContain("Slack");
  });

  it("should produce header with no fields when all options are undefined", () => {
    const result = buildUserInfo({});

    expect(result).toBe("# Current User Info\n");
  });

  it("should handle all fields simultaneously", () => {
    const result = buildUserInfo({
      name: "Charlie",
      email: "charlie@test.com",
      timezone: "Europe/London",
      slackDisplayName: "charlie.slack",
      slackUserId: "U99999",
    });

    expect(result).toContain("Name: Charlie");
    expect(result).toContain("Email: charlie@test.com");
    expect(result).toContain("Timezone: Europe/London");
    expect(result).toContain("Slack display name: charlie.slack");
    expect(result).toContain("Slack user ID: U99999");
    // Verify order: name, email, timezone, slack fields
    const nameIdx = result.indexOf("Name:");
    const emailIdx = result.indexOf("Email:");
    const tzIdx = result.indexOf("Timezone:");
    const slackNameIdx = result.indexOf("Slack display name:");
    const slackIdIdx = result.indexOf("Slack user ID:");
    expect(nameIdx).toBeLessThan(emailIdx);
    expect(emailIdx).toBeLessThan(tzIdx);
    expect(tzIdx).toBeLessThan(slackNameIdx);
    expect(slackNameIdx).toBeLessThan(slackIdIdx);
  });
});
