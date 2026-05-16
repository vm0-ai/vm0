import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import type { ReadonlyDb } from "../../external/db";
import { findBestRunner, notifyRunnerJob } from "../runner-dispatch.service";

const context = testContext();

interface RunnerRow {
  readonly runnerId: string;
  readonly maxConcurrent: number;
  readonly runningCount: number;
  readonly heldSessions: readonly string[];
  readonly profiles: readonly string[];
}

function runnerRow(overrides: Partial<RunnerRow> = {}): RunnerRow {
  return {
    runnerId: `runner_${randomUUID()}`,
    maxConcurrent: 4,
    runningCount: 0,
    heldSessions: [],
    profiles: ["vm0/default"],
    ...overrides,
  };
}

function dbReturning(runners: readonly RunnerRow[]): ReadonlyDb {
  return {
    select: () => {
      return {
        from: () => {
          return {
            where: () => {
              return Promise.resolve(runners);
            },
          };
        },
      };
    },
  } as unknown as ReadonlyDb;
}

describe("runner dispatch affinity", () => {
  it("finds a runner holding the requested session", async () => {
    const targetRunnerId = `runner_${randomUUID()}`;
    const db = dbReturning([
      runnerRow({ heldSessions: ["other-session"] }),
      runnerRow({
        runnerId: targetRunnerId,
        heldSessions: ["session-a"],
      }),
      runnerRow({
        heldSessions: ["session-a"],
        runningCount: 4,
        maxConcurrent: 4,
      }),
      runnerRow({
        heldSessions: ["session-a"],
        profiles: ["vm0/large"],
      }),
    ]);

    await expect(
      findBestRunner(db, "vm0/test", "vm0/default", "session-a"),
    ).resolves.toStrictEqual({ runnerId: targetRunnerId });
  });

  it("publishes targetRunnerId when a matching held session exists", async () => {
    const targetRunnerId = `runner_${randomUUID()}`;
    const db = dbReturning([
      runnerRow({ runnerId: targetRunnerId, heldSessions: ["session-a"] }),
    ]);
    const runId = randomUUID();

    await notifyRunnerJob(db, {
      runnerGroup: "vm0/test",
      runId,
      profile: "vm0/default",
      sessionId: "session-a",
    });

    expect(context.mocks.ably.publish).toHaveBeenCalledWith("job", {
      runId,
      profile: "vm0/default",
      targetRunnerId,
    });
  });

  it("falls back to broadcast when there is no matching session", async () => {
    const db = dbReturning([runnerRow({ heldSessions: ["other-session"] })]);
    const runId = randomUUID();

    await notifyRunnerJob(db, {
      runnerGroup: "vm0/test",
      runId,
      profile: "vm0/default",
      sessionId: "session-a",
    });

    expect(context.mocks.ably.publish).toHaveBeenCalledWith("job", {
      runId,
      profile: "vm0/default",
    });
  });
});
