import { runnerState } from "@vm0/db/schema/runner-state";
import { and, eq, gt } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import { publishRunnerJobNotification } from "../external/realtime";
import { now } from "../external/time";
import { safeAsync } from "../utils";
import { logger } from "../../lib/log";

const L = logger("RunnerDispatch");

const STALE_THRESHOLD_MS = 60_000;

async function findBestRunner(
  db: ReadonlyDb,
  group: string,
  profile: string,
  sessionId: string | null,
): Promise<{ readonly runnerId: string } | null> {
  if (!sessionId) {
    return null;
  }

  const staleThreshold = new Date(now() - STALE_THRESHOLD_MS);
  const runners = await db
    .select({
      runnerId: runnerState.runnerId,
      maxConcurrent: runnerState.maxConcurrent,
      runningCount: runnerState.runningCount,
      heldSessions: runnerState.heldSessions,
      profiles: runnerState.profiles,
    })
    .from(runnerState)
    .where(
      and(
        eq(runnerState.runnerGroup, group),
        gt(runnerState.lastSeenAt, staleThreshold),
        eq(runnerState.mode, "running"),
      ),
    );

  const candidates = runners.filter((runner) => {
    const hasCapacity =
      runner.maxConcurrent === 0 || runner.maxConcurrent > runner.runningCount;
    return hasCapacity && runner.profiles.includes(profile);
  });

  const affinityRunner = candidates.find((runner) => {
    return runner.heldSessions.includes(sessionId);
  });

  return affinityRunner ? { runnerId: affinityRunner.runnerId } : null;
}

export async function notifyRunnerJob(
  db: ReadonlyDb,
  args: {
    readonly runnerGroup: string;
    readonly runId: string;
    readonly profile: string;
    readonly sessionId: string | null;
  },
): Promise<boolean> {
  const target = await safeAsync(() => {
    return findBestRunner(db, args.runnerGroup, args.profile, args.sessionId);
  });
  const targetRunnerId = "ok" in target ? (target.ok?.runnerId ?? null) : null;
  if (!("ok" in target)) {
    L.warn("findBestRunner failed for run, using broadcast", {
      runId: args.runId,
      error: target.error,
    });
  }

  return await publishRunnerJobNotification(
    args.runnerGroup,
    args.runId,
    args.profile,
    targetRunnerId,
  );
}
