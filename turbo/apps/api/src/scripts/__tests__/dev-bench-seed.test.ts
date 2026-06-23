import { describe, expect, it } from "vitest";

import { buildProfileRows, DEV_BENCH_THREAD_PROFILES } from "../dev-bench-seed";

const EXPECTED_PROFILE_SHAPES = {
  "feature-switch-digest": {
    messages: 1421,
    runs: 134,
    userMessages: 139,
    assistantMessages: 1282,
    nullRunMessages: 9,
    completedLifecycleMessages: 133,
    failedLifecycleMessages: 1,
    recommendedFollowupMessages: 72,
    usageMessages: 32,
    automationIdMessages: 19,
    automationTitleMessages: 46,
    revokeMessages: 6,
  },
  "release-pr-auto-merge": {
    messages: 2821,
    runs: 142,
    userMessages: 142,
    assistantMessages: 2679,
    nullRunMessages: 0,
    completedLifecycleMessages: 142,
    failedLifecycleMessages: 0,
    recommendedFollowupMessages: 142,
    usageMessages: 0,
    automationIdMessages: 51,
    automationTitleMessages: 135,
    revokeMessages: 6,
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
      expect(rows.messageRows).toHaveLength(expected.messages);
      expect(
        countWhere(rows.messageRows, (row) => {
          return row.role === "user";
        }),
      ).toBe(expected.userMessages);
      expect(
        countWhere(rows.messageRows, (row) => {
          return row.role === "assistant";
        }),
      ).toBe(expected.assistantMessages);
      expect(
        countWhere(rows.messageRows, (row) => {
          return row.runId === null;
        }),
      ).toBe(expected.nullRunMessages);
      expect(
        countWhere(rows.messageRows, (row) => {
          return row.runLifecycleEvent === "completed";
        }),
      ).toBe(expected.completedLifecycleMessages);
      expect(
        countWhere(rows.messageRows, (row) => {
          return row.runLifecycleEvent === "failed";
        }),
      ).toBe(expected.failedLifecycleMessages);
      expect(
        countWhere(rows.messageRows, (row) => {
          return (
            row.recommendedFollowups !== null &&
            row.recommendedFollowups !== undefined
          );
        }),
      ).toBe(expected.recommendedFollowupMessages);
      expect(
        countWhere(rows.messageRows, (row) => {
          return row.usagePayload !== null && row.usagePayload !== undefined;
        }),
      ).toBe(expected.usageMessages);
      expect(
        countWhere(rows.messageRows, (row) => {
          return row.automationId !== null && row.automationId !== undefined;
        }),
      ).toBe(expected.automationIdMessages);
      expect(
        countWhere(rows.messageRows, (row) => {
          return (
            row.automationTitle !== null && row.automationTitle !== undefined
          );
        }),
      ).toBe(expected.automationTitleMessages);
      expect(
        countWhere(rows.messageRows, (row) => {
          return (
            row.revokesMessageId !== null && row.revokesMessageId !== undefined
          );
        }),
      ).toBe(expected.revokeMessages);

      const sequencesByRun = new Map<string, number[]>();
      for (const row of rows.messageRows) {
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
