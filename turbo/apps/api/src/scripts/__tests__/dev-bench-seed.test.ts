import { describe, expect, it } from "vitest";
import { chatEventCompatibilityRole } from "@vm0/api-contracts/contracts/chat-events";

import { buildProfileRows, DEV_BENCH_THREAD_PROFILES } from "../dev-bench-seed";

const EXPECTED_PROFILE_SHAPES = {
  "feature-switch-digest": {
    events: 1429,
    runs: 134,
    userMessages: 139,
    assistantEvents: 1290,
    nullRunEvents: 9,
    completedLifecycleEvents: 133,
    failedLifecycleEvents: 1,
    recommendedFollowupEvents: 72,
    usageEvents: 32,
    workflowScheduleRuns: 46,
    triggerBriefRuns: 46,
    revokeEvents: 6,
  },
  "release-pr-auto-merge": {
    events: 2821,
    runs: 142,
    userMessages: 142,
    assistantEvents: 2679,
    nullRunEvents: 0,
    completedLifecycleEvents: 142,
    failedLifecycleEvents: 0,
    recommendedFollowupEvents: 142,
    usageEvents: 0,
    workflowScheduleRuns: 135,
    triggerBriefRuns: 135,
    revokeEvents: 6,
  },
} as const;

function countWhere<T>(
  rows: readonly T[],
  predicate: (row: T) => boolean,
): number {
  return rows.filter(predicate).length;
}

describe("dev bench seed profile rows", () => {
  it("preserves the production-shaped profile invariants", () => {
    for (const profile of DEV_BENCH_THREAD_PROFILES) {
      const expected =
        EXPECTED_PROFILE_SHAPES[
          profile.slug as keyof typeof EXPECTED_PROFILE_SHAPES
        ];
      if (!expected) {
        throw new Error(`Missing expected shape for ${profile.slug}`);
      }
      const rows = buildProfileRows({
        userId: "00000000-0000-0000-0000-000000000001",
        orgId: "00000000-0000-0000-0000-000000000002",
        versionId: "dev-bench-version",
        threadId: "00000000-0000-0000-0000-000000000003",
        sessionId: "00000000-0000-0000-0000-000000000004",
        profile,
      });

      expect(rows.runRows).toHaveLength(expected.runs);
      expect(rows.zeroRunRows).toHaveLength(expected.runs);
      expect(rows.eventRows).toHaveLength(expected.events);
      expect(
        rows.eventRows.some((row) => {
          return "role" in row;
        }),
      ).toBeFalsy();
      expect(
        countWhere(rows.eventRows, (row) => {
          return chatEventCompatibilityRole(row.eventType) === "user";
        }),
      ).toBe(expected.userMessages);
      expect(
        countWhere(rows.eventRows, (row) => {
          return chatEventCompatibilityRole(row.eventType) === "assistant";
        }),
      ).toBe(expected.assistantEvents);
      expect(
        countWhere(rows.eventRows, (row) => {
          return row.runId === null;
        }),
      ).toBe(expected.nullRunEvents);
      expect(
        countWhere(rows.eventRows, (row) => {
          return row.runLifecycleEvent === "completed";
        }),
      ).toBe(expected.completedLifecycleEvents);
      expect(
        countWhere(rows.eventRows, (row) => {
          return row.runLifecycleEvent === "failed";
        }),
      ).toBe(expected.failedLifecycleEvents);
      expect(
        countWhere(rows.eventRows, (row) => {
          return (
            row.recommendedFollowups !== null &&
            row.recommendedFollowups !== undefined
          );
        }),
      ).toBe(expected.recommendedFollowupEvents);
      expect(
        countWhere(rows.eventRows, (row) => {
          return row.usagePayload !== null && row.usagePayload !== undefined;
        }),
      ).toBe(expected.usageEvents);
      expect(
        countWhere(rows.zeroRunRows, (row) => {
          return row.triggerSource === "workflow-schedule";
        }),
      ).toBe(expected.workflowScheduleRuns);
      expect(
        countWhere(rows.zeroRunRows, (row) => {
          return row.triggerBrief !== null && row.triggerBrief !== undefined;
        }),
      ).toBe(expected.triggerBriefRuns);
      expect(
        countWhere(rows.eventRows, (row) => {
          return (
            row.revokesEventId !== null && row.revokesEventId !== undefined
          );
        }),
      ).toBe(expected.revokeEvents);

      const sequencesByRun = new Map<string, number[]>();
      for (const row of rows.eventRows) {
        if (row.runId && typeof row.sequenceNumber === "number") {
          const sequences = sequencesByRun.get(row.runId) ?? [];
          sequences.push(row.sequenceNumber);
          sequencesByRun.set(row.runId, sequences);
        }
      }

      for (const sequences of sequencesByRun.values()) {
        expect(new Set(sequences).size).toBe(sequences.length);
        for (const sequenceNumber of sequences) {
          expect(sequenceNumber).toBeGreaterThan(0);
          expect(sequenceNumber).toBeLessThanOrEqual(profile.sequenceMax);
        }
      }
    }
  });
});
