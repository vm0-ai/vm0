/**
 * Missing operator-managed keys are global infrastructure state and cannot be
 * isolated through a user-facing API. This fixture scopes that state to one
 * async request chain so route tests never delete or restore shared key rows.
 */
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { pgIntegerDecoder } from "../lib/db-structured-result";
import { withBuiltInModelRuntimeRouteUnavailableForTest as withRuntimeRouteUnavailable } from "../signals/services/built-in-model-runtime-route.service";
import { createDeferredPromise } from "../signals/utils";

const waiterCountRowSchema = z.object({ waiterCount: z.int() });

interface HeldBuiltInModelCandidateRouteLock {
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}

export function withBuiltInModelRuntimeRouteUnavailableForTest<T>(
  selectedModel: string,
  work: () => Promise<T>,
): Promise<T> {
  return withRuntimeRouteUnavailable(selectedModel, work);
}

/** Holds one production candidate-route row lock for a route-level test. */
export async function holdBuiltInModelCandidateRouteLockFixture(args: {
  readonly selectedModel: string;
  readonly providerType: string;
  readonly upstreamModel: string;
  readonly signal: AbortSignal;
}): Promise<HeldBuiltInModelCandidateRouteLock> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [row] = await tx
      .select({ pid: sql`pg_backend_pid()`.mapWith(pgIntegerDecoder) })
      .from(builtInModelCandidateCooldown)
      .where(
        and(
          eq(builtInModelCandidateCooldown.selectedModel, args.selectedModel),
          eq(builtInModelCandidateCooldown.providerType, args.providerType),
          eq(builtInModelCandidateCooldown.upstreamModel, args.upstreamModel),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) {
      throw new Error("Expected the built-in model candidate route to lock");
    }
    started.resolve(row.pid);
    await released.promise;
  });
  const holderPid = await started.promise;
  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_stat_activity AS activity
          WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
        `,
        waiterCountRowSchema,
      );
      return rows[0]?.waiterCount ?? 0;
    },
  };
}
