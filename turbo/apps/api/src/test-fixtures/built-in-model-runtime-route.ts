import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";
import { withBuiltInModelRuntimeRouteUnavailableForTest as withRuntimeRouteUnavailable } from "../signals/services/built-in-model-runtime-route.service";

const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });

interface BuiltInModelRuntimeRouteFixtureIdentity {
  readonly selectedModel: string;
  readonly providerType: string;
  readonly upstreamModel: string;
}

interface BuiltInModelCandidateCooldownFixture {
  readonly unavailableUntil: Date;
  readonly connectionObservationStartedAt: Date | null;
  readonly connectionObservationUntil: Date | null;
}

interface HeldBuiltInModelRouteBoundary {
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}

/**
 * Missing operator-managed keys are global infrastructure state and cannot be
 * isolated through a user-facing API. This fixture scopes that state to one
 * async request chain so route tests never delete or restore shared key rows.
 */
export function withBuiltInModelRuntimeRouteUnavailableForTest<T>(
  selectedModel: string,
  work: () => Promise<T>,
): Promise<T> {
  return withRuntimeRouteUnavailable(selectedModel, work);
}

function routeCondition(route: BuiltInModelRuntimeRouteFixtureIdentity) {
  return and(
    eq(builtInModelCandidateCooldown.selectedModel, route.selectedModel),
    eq(builtInModelCandidateCooldown.providerType, route.providerType),
    eq(builtInModelCandidateCooldown.upstreamModel, route.upstreamModel),
  );
}

async function blockedWaiterCount(holderPid: number): Promise<number> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT ${count()}::int AS "waiterCount"
      FROM pg_stat_activity AS activity
      WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
    `,
    waiterCountRowSchema,
  );
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error("Expected one built-in model route waiter count row");
  }
  return row.waiterCount;
}

async function transactionBackendPid(
  tx: Parameters<typeof executeRawRows>[0],
): Promise<number> {
  const rows = await executeRawRows(
    tx,
    sql`SELECT pg_backend_pid() AS "pid"`,
    databasePidRowSchema,
  );
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error("Expected one built-in model route fixture backend pid");
  }
  return row.pid;
}

export async function readBuiltInModelCandidateCooldownFixture(
  route: BuiltInModelRuntimeRouteFixtureIdentity,
): Promise<BuiltInModelCandidateCooldownFixture | null> {
  const [row] = await db()
    .select({
      unavailableUntil: builtInModelCandidateCooldown.unavailableUntil,
      connectionObservationStartedAt:
        builtInModelCandidateCooldown.connectionObservationStartedAt,
      connectionObservationUntil:
        builtInModelCandidateCooldown.connectionObservationUntil,
    })
    .from(builtInModelCandidateCooldown)
    .where(routeCondition(route))
    .limit(1);
  return row ?? null;
}

/** Holds the exact production route row so receipt-time behavior is testable. */
export async function holdBuiltInModelRouteLockFixture(args: {
  readonly route: BuiltInModelRuntimeRouteFixtureIdentity;
  readonly signal: AbortSignal;
}): Promise<HeldBuiltInModelRouteBoundary> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const rows = await tx
      .select({ selectedModel: builtInModelCandidateCooldown.selectedModel })
      .from(builtInModelCandidateCooldown)
      .where(routeCondition(args.route))
      .for("update");
    if (rows.length !== 1) {
      throw new Error("Expected one built-in model route fixture row");
    }
    started.resolve(await transactionBackendPid(tx));
    await released.promise;
  });
  const pid = await started.promise;
  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await blockedWaiterCount(pid);
    },
  };
}
