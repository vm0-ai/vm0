import { randomUUID } from "node:crypto";

import { runnerState } from "@vm0/db/schema/runner-state";
import { createStore } from "ccstate";
import { inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { notifyRunnerJob } from "../runner-dispatch.service";

const context = testContext();
const store = createStore();

interface RunnerStateFixture {
  readonly runnerId: string;
  readonly runnerGroup?: string;
  readonly profiles?: string[];
  readonly maxConcurrent?: number;
  readonly runningCount?: number;
  readonly heldSessions?: string[];
  readonly mode?: string;
  readonly lastSeenAt?: Date;
}

describe("runner dispatch affinity", () => {
  const runnerStateIds: string[] = [];

  async function seedRunnerState(overrides: RunnerStateFixture): Promise<void> {
    runnerStateIds.push(overrides.runnerId);
    const db = store.set(writeDb$);
    await db.insert(runnerState).values({
      runnerId: overrides.runnerId,
      runnerName: `runner-${overrides.runnerId.slice(0, 8)}`,
      runnerGroup: overrides.runnerGroup ?? "vm0/test",
      profiles: overrides.profiles ?? ["vm0/default"],
      totalVcpu: 8,
      totalMemoryMb: 16_384,
      maxConcurrent: overrides.maxConcurrent ?? 4,
      allocatedVcpu: 0,
      allocatedMemoryMb: 0,
      runningCount: overrides.runningCount ?? 0,
      heldSessions: overrides.heldSessions ?? [],
      mode: overrides.mode ?? "running",
      lastSeenAt: overrides.lastSeenAt ?? new Date(now()),
    });
  }

  afterEach(async () => {
    if (runnerStateIds.length === 0) {
      return;
    }

    const db = store.set(writeDb$);
    await db
      .delete(runnerState)
      .where(inArray(runnerState.runnerId, [...runnerStateIds]));
    runnerStateIds.length = 0;
  });

  it("publishes targetRunnerId for an active matching runner with capacity", async () => {
    const targetRunnerId = randomUUID();
    await Promise.all([
      seedRunnerState({
        runnerId: randomUUID(),
        heldSessions: ["session-a"],
        lastSeenAt: new Date(now() - 90_000),
      }),
      seedRunnerState({
        runnerId: randomUUID(),
        heldSessions: ["session-a"],
        mode: "draining",
      }),
      seedRunnerState({
        runnerId: randomUUID(),
        runnerGroup: "vm0/other",
        heldSessions: ["session-a"],
      }),
      seedRunnerState({
        runnerId: randomUUID(),
        heldSessions: ["session-a"],
        maxConcurrent: 4,
        runningCount: 4,
      }),
      seedRunnerState({
        runnerId: randomUUID(),
        heldSessions: ["session-a"],
        profiles: ["vm0/large"],
      }),
      seedRunnerState({
        runnerId: randomUUID(),
        heldSessions: ["other-session"],
      }),
      seedRunnerState({
        runnerId: targetRunnerId,
        heldSessions: ["session-a"],
      }),
    ]);
    const db = store.set(writeDb$);
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

  it("falls back to broadcast when matching session runners are ineligible", async () => {
    await Promise.all([
      seedRunnerState({
        runnerId: randomUUID(),
        heldSessions: ["session-a"],
        lastSeenAt: new Date(now() - 90_000),
      }),
      seedRunnerState({
        runnerId: randomUUID(),
        heldSessions: ["session-a"],
        mode: "draining",
      }),
      seedRunnerState({
        runnerId: randomUUID(),
        runnerGroup: "vm0/other",
        heldSessions: ["session-a"],
      }),
      seedRunnerState({
        runnerId: randomUUID(),
        heldSessions: ["session-a"],
        maxConcurrent: 1,
        runningCount: 1,
      }),
      seedRunnerState({
        runnerId: randomUUID(),
        heldSessions: ["session-a"],
        profiles: ["vm0/large"],
      }),
      seedRunnerState({
        runnerId: randomUUID(),
        heldSessions: ["other-session"],
      }),
    ]);
    const db = store.set(writeDb$);
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
