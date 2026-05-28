import {
  runnerState,
  type RunnerHeldSessionState,
} from "@vm0/db/schema/runner-state";
import { and, eq, gt } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import { publishRunnerJobNotification } from "../external/realtime";
import { now } from "../external/time";
import { settle } from "../utils";
import { logger } from "../../lib/log";

const L = logger("RunnerDispatch");

const STALE_THRESHOLD_MS = 60_000;

function newestHeldSessionAt(
  states: readonly RunnerHeldSessionState[],
  sessionId: string,
): string | null {
  let newest: string | null = null;
  for (const state of states) {
    if (state.sessionId !== sessionId) {
      continue;
    }
    if (!newest || state.lastCompletedAt > newest) {
      newest = state.lastCompletedAt;
    }
  }
  return newest;
}

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
      heldSessionStates: runnerState.heldSessionStates,
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

  let best: {
    readonly runnerId: string;
    readonly lastCompletedAt: string;
  } | null = null;
  for (const runner of candidates) {
    const lastCompletedAt = newestHeldSessionAt(
      runner.heldSessionStates,
      sessionId,
    );
    if (!lastCompletedAt) {
      continue;
    }
    if (!best || lastCompletedAt > best.lastCompletedAt) {
      best = { runnerId: runner.runnerId, lastCompletedAt };
    }
  }

  return best ? { runnerId: best.runnerId } : null;
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
  const target = await settle(
    findBestRunner(db, args.runnerGroup, args.profile, args.sessionId),
  );
  const targetRunnerId = target.ok ? (target.value?.runnerId ?? null) : null;
  if (!target.ok) {
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
