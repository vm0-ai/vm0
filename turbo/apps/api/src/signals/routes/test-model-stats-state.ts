import { command } from "ccstate";
import {
  testModelStatsStateContract,
  type TestModelStatsStateActionBody,
} from "@vm0/api-contracts/contracts/test-model-stats-state";
import { modelStat } from "@vm0/db/schema/model-stat";
import { modelUsageObservation } from "@vm0/db/schema/model-usage-observation";
import { and, asc, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { executeRawRows } from "../../lib/db-raw-rows";
import { testOverride } from "../../lib/singleton";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { lockModelStatsAggregation } from "../services/model-stats-aggregation-lock.service";
import { createDeferredPromise, onRejection } from "../utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testModelStatsStateContract.action);

interface ModelStatsAggregationLockGate {
  holderPid: number | null;
  readonly released: ReturnType<typeof createDeferredPromise<void>>;
  readonly release: () => void;
}

const aggregationLockGate = testOverride<ModelStatsAggregationLockGate | null>(
  () => {
    return null;
  },
);

const lockHolderRowSchema = z.object({ holderPid: z.int() });
const lockStateRowSchema = z.object({
  held: z.boolean(),
  waiterCount: z.int().nonnegative(),
});

function createAggregationLockGate(
  signal: AbortSignal,
): ModelStatsAggregationLockGate {
  const released = createDeferredPromise<void>(signal);
  return {
    holderPid: null,
    released,
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
  };
}

function clearAggregationLockGate(gate: ModelStatsAggregationLockGate): void {
  if (aggregationLockGate.get() === gate) {
    aggregationLockGate.clear();
  }
}

async function holdAggregationLock(db: Db, signal: AbortSignal): Promise<void> {
  if (aggregationLockGate.get()) {
    throw new Error("A model stats aggregation lock gate is already active");
  }
  const gate = createAggregationLockGate(signal);
  aggregationLockGate.set(gate);
  await onRejection(
    db.transaction(async (tx) => {
      await lockModelStatsAggregation(tx);
      signal.throwIfAborted();
      const rows = await executeRawRows(
        tx,
        sql`SELECT pg_backend_pid() AS "holderPid"`,
        lockHolderRowSchema,
      );
      signal.throwIfAborted();
      const holder = rows[0];
      if (!holder) {
        throw new Error("Failed to read model stats lock holder");
      }
      gate.holderPid = holder.holderPid;
      await gate.released.promise;
    }),
    () => {
      clearAggregationLockGate(gate);
    },
  );
  clearAggregationLockGate(gate);
}

async function readAggregationLockState(
  db: Db,
  signal: AbortSignal,
): Promise<{ readonly held: boolean; readonly waiterCount: number }> {
  const holderPid = aggregationLockGate.get()?.holderPid;
  if (holderPid === null || holderPid === undefined) {
    return { held: false, waiterCount: 0 };
  }
  const rows = await executeRawRows(
    db,
    sql`
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_locks held
          WHERE
            held.pid = ${holderPid}
            AND held.locktype = 'advisory'
            AND held.granted
        ) AS "held",
        (
          SELECT COUNT(*)::int
          FROM pg_locks held
          INNER JOIN pg_locks waiting
            ON waiting.locktype = held.locktype
            AND waiting.database IS NOT DISTINCT FROM held.database
            AND waiting.classid IS NOT DISTINCT FROM held.classid
            AND waiting.objid IS NOT DISTINCT FROM held.objid
            AND waiting.objsubid IS NOT DISTINCT FROM held.objsubid
          WHERE
            held.pid = ${holderPid}
            AND held.locktype = 'advisory'
            AND held.granted
            AND NOT waiting.granted
        ) AS "waiterCount"
    `,
    lockStateRowSchema,
  );
  signal.throwIfAborted();
  const state = rows[0];
  if (!state) {
    throw new Error("Failed to read model stats aggregation lock state");
  }
  return state;
}

async function readObservations(
  db: Db,
  idempotencyKeys: readonly string[],
  signal: AbortSignal,
) {
  const rows = await db
    .select({
      idempotencyKey: modelUsageObservation.idempotencyKey,
      aggregatedAt: modelUsageObservation.aggregatedAt,
    })
    .from(modelUsageObservation)
    .where(inArray(modelUsageObservation.idempotencyKey, idempotencyKeys))
    .orderBy(asc(modelUsageObservation.idempotencyKey));
  signal.throwIfAborted();
  return rows;
}

async function deleteObservations(
  db: Db,
  idempotencyKeys: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  await db
    .delete(modelUsageObservation)
    .where(inArray(modelUsageObservation.idempotencyKey, idempotencyKeys));
  signal.throwIfAborted();
}

async function insertZeroTokenObservation(
  db: Db,
  body: Extract<
    TestModelStatsStateActionBody,
    { action: "insert-zero-token-observation" }
  >,
  signal: AbortSignal,
): Promise<void> {
  await db.insert(modelUsageObservation).values({
    idempotencyKey: body.idempotency_key,
    model: body.model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    observedAt: new Date(body.observed_at),
  });
  signal.throwIfAborted();
}

async function deleteFixture(
  db: Db,
  body: Extract<TestModelStatsStateActionBody, { action: "delete-fixture" }>,
  signal: AbortSignal,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(modelUsageObservation)
      .where(
        inArray(modelUsageObservation.idempotencyKey, body.idempotency_keys),
      );
    signal.throwIfAborted();
    await tx
      .delete(modelStat)
      .where(
        and(
          gte(modelStat.hourStart, new Date(body.window_start)),
          lt(modelStat.hourStart, new Date(body.window_end)),
          inArray(modelStat.model, body.models),
        ),
      );
    signal.throwIfAborted();
  });
}

async function mutateModelStatsState(
  db: Db,
  body: TestModelStatsStateActionBody,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "hold-aggregation-lock": {
      await holdAggregationLock(db, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "read-aggregation-lock-state": {
      const state = await readAggregationLockState(db, signal);
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          aggregation_lock_held: state.held,
          aggregation_lock_waiter_count: state.waiterCount,
        },
      };
    }
    case "release-aggregation-lock": {
      aggregationLockGate.get()?.release();
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "read-observations": {
      const rows = await readObservations(db, body.idempotency_keys, signal);
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          observations: rows.map((row) => {
            return {
              idempotency_key: row.idempotencyKey,
              aggregated_at: row.aggregatedAt?.toISOString() ?? null,
            };
          }),
        },
      };
    }
    case "insert-zero-token-observation": {
      await insertZeroTokenObservation(db, body, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "delete-observations": {
      await deleteObservations(db, body.idempotency_keys, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "delete-fixture": {
      await deleteFixture(db, body, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
  }
}

const mutateModelStatsState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    return await mutateModelStatsState(set(writeDb$), bodyResult.data, signal);
  },
);

export const testModelStatsStateRoutes: readonly RouteEntry[] = [
  {
    route: testModelStatsStateContract.action,
    handler: mutateModelStatsState$,
  },
];
