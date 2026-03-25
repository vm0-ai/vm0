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
    nextRunAt: null,
    lastRunAt: null,
    ...overrides,
  };
}

describe("buildCombinedSchedule", () => {
  it("should use default agent name when entry agentId matches defaultComposeId", () => {
    const entries = [makeEntry({ agentId: "default-uuid" })];
    const nameToDisplay = new Map<string, string>();
    const result = buildCombinedSchedule(
      entries,
      "Zero",
      "default-uuid",
      nameToDisplay,
    );
    expect(result[0].agentLabel).toBe("Zero");
  });

  it("should resolve agent label from nameToDisplay map keyed by agent id", () => {
    const entries = [makeEntry({ agentId: "sub-agent-uuid" })];
    const nameToDisplay = new Map([["sub-agent-uuid", "Research Agent"]]);
    const result = buildCombinedSchedule(
      entries,
      "Zero",
      "default-uuid",
      nameToDisplay,
    );
    expect(result[0].agentLabel).toBe("Research Agent");
  });

  it("should fall back to raw agentId when not in nameToDisplay map", () => {
    const entries = [makeEntry({ agentId: "unknown-uuid" })];
    const nameToDisplay = new Map([["other-uuid", "Other Agent"]]);
    const result = buildCombinedSchedule(
      entries,
      "Zero",
      "default-uuid",
      nameToDisplay,
    );
    expect(result[0].agentLabel).toBe("unknown-uuid");
  });

  it("should handle multiple entries with different agents", () => {
    const entries = [
      makeEntry({ id: "s1", agentId: "default-uuid" }),
      makeEntry({ id: "s2", agentId: "agent-a" }),
      makeEntry({ id: "s3", agentId: "agent-b" }),
    ];
    const nameToDisplay = new Map([
      ["agent-a", "Alpha Agent"],
      ["agent-b", "Beta Agent"],
    ]);
    const result = buildCombinedSchedule(
      entries,
      "Zero",
      "default-uuid",
      nameToDisplay,
    );
    expect(result[0].agentLabel).toBe("Zero");
    expect(result[1].agentLabel).toBe("Alpha Agent");
    expect(result[2].agentLabel).toBe("Beta Agent");
  });
});
