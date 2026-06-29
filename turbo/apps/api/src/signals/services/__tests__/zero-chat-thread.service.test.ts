import { describe, expect, it } from "vitest";

import { buildWorkflowScheduleTriggerBrief } from "../zero-chat-thread.service";

describe("buildWorkflowScheduleTriggerBrief", () => {
  it("formats cron triggers with the user timezone and a readable rule", () => {
    expect(
      buildWorkflowScheduleTriggerBrief({
        createdAt: new Date("2026-06-29T09:40:00Z"),
        scheduleType: "cron",
        cronExpression: "40 17 * * 1-5",
        intervalSeconds: null,
        atTime: null,
        triggerTimezone: "Asia/Shanghai",
        userTimezone: "Asia/Shanghai",
      }),
    ).toBe(
      [
        "Triggered at 5:40 PM, Jun 29, 2026 (Asia/Shanghai)",
        "Schedule: Every weekday at 5:40 PM",
      ].join("\n"),
    );
  });

  it("formats loop triggers with friendly interval units", () => {
    expect(
      buildWorkflowScheduleTriggerBrief({
        createdAt: new Date("2026-06-29T09:40:00Z"),
        scheduleType: "loop",
        cronExpression: null,
        intervalSeconds: 3600,
        atTime: null,
        triggerTimezone: "UTC",
        userTimezone: "Asia/Shanghai",
      }),
    ).toBe(
      [
        "Triggered at 5:40 PM, Jun 29, 2026 (Asia/Shanghai)",
        "Every 1 hour",
      ].join("\n"),
    );
  });

  it("formats one-time triggers without ISO timestamps", () => {
    expect(
      buildWorkflowScheduleTriggerBrief({
        createdAt: new Date("2026-06-29T09:40:00Z"),
        scheduleType: "once",
        cronExpression: null,
        intervalSeconds: null,
        atTime: new Date("2026-06-30T01:05:00Z"),
        triggerTimezone: "UTC",
        userTimezone: "America/Los_Angeles",
      }),
    ).toBe("Once at 6:05 PM, Jun 29, 2026 (America/Los_Angeles)");
  });
});
