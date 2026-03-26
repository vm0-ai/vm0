import { describe, expect, it } from "vitest";
import { buildCombinedSchedule } from "../zero-schedule-page.tsx";
import type { OrgScheduleEntry } from "../../../signals/zero-page/zero-schedule.ts";

function makeEntry(
  overrides: Partial<OrgScheduleEntry> = {},
): OrgScheduleEntry {
  return {
    id: "sched-1",
    time: "Every weekday at 9:00 AM",
    prompt: "Do something",
    description: null,
    enabled: true,
    notifyEmail: false,
    notifySlack: false,
    slackChannelId: null,
    name: "my-schedule",
    timezone: "UTC",
    intervalSeconds: null,
    agentId: "agent-uuid-1",
    displayName: null,
    nextRunAt: null,
    lastRunAt: null,
    ...overrides,
  };
}

describe("buildCombinedSchedule", () => {
  it("should use displayName as agentLabel when set", () => {
    const entries = [makeEntry({ displayName: "Zero" })];
    const result = buildCombinedSchedule(entries);
    expect(result[0].agentLabel).toBe("Zero");
  });

  it("should fall back to agentId when displayName is null", () => {
    const entries = [makeEntry({ agentId: "unknown-uuid", displayName: null })];
    const result = buildCombinedSchedule(entries);
    expect(result[0].agentLabel).toBe("unknown-uuid");
  });

  it("should handle multiple entries with different agents", () => {
    const entries = [
      makeEntry({ id: "s1", agentId: "default-uuid", displayName: "Zero" }),
      makeEntry({
        id: "s2",
        agentId: "agent-a",
        displayName: "Alpha Agent",
      }),
      makeEntry({
        id: "s3",
        agentId: "agent-b",
        displayName: "Beta Agent",
      }),
    ];
    const result = buildCombinedSchedule(entries);
    expect(result[0].agentLabel).toBe("Zero");
    expect(result[1].agentLabel).toBe("Alpha Agent");
    expect(result[2].agentLabel).toBe("Beta Agent");
  });
});
