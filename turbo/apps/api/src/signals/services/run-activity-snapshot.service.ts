import { FeatureSwitchKey, isFeatureEnabled } from "@okouai/core";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { runActivitySnapshots } from "@okouai/db/schema/run-activity-snapshot";
import { command } from "ccstate";
import { and, asc, eq, getTableColumns, inArray, lte, sql } from "drizzle-orm";
import { eventConsumerPayload$ } from "../../lib/event-consumer/route";
import { logger } from "../../lib/log";
import {
  isForeignKeyViolation,
  isLockNotAvailable,
  isQueryCanceled,
  safeSqlStateCode,
} from "../../lib/pg-errors";
import {
  ACTIVITY_RETENTION_MS,
  activityRevision,
  mergeActivity,
} from "../../lib/run-activity";
import { writeDb$, type Db } from "../external/db";
import { settleIncludingAbort } from "../utils";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

const log = logger("api:run-activity");
/** The snapshot row disappeared between the upsert and the locking read. */
const SNAPSHOT_MISSING = "Activity snapshot missing after insert";
/** Where the transaction stood when it failed. Finite and content-free. */
type CaptureStage = "admission" | "lock" | "persist" | "commit";
/**
 * Failure classes worth separating in production. `contended` and `run_missing`
 * are expected outcomes of concurrent delivery, not defects; everything else
 * keeps an actionable level and carries its SQLSTATE class code.
 */
type CaptureFailure =
  | "contended"
  | "run_missing"
  | "interrupted"
  | "snapshot_missing"
  | "write_failed";

function captureFailure(error: unknown): CaptureFailure {
  if (isLockNotAvailable(error)) {
    return "contended";
  }
  if (isForeignKeyViolation(error)) {
    return "run_missing";
  }
  if (isQueryCanceled(error)) {
    return "interrupted";
  }
  if (error instanceof Error && error.message === SNAPSHOT_MISSING) {
    return "snapshot_missing";
  }
  return "write_failed";
}

/** Concurrent delivery for one run is normal; only real faults need a level. */
function isExpectedFailure(failure: CaptureFailure): boolean {
  return failure === "contended" || failure === "run_missing";
}

export const activityClock = sql`(statement_timestamp() AT TIME ZONE 'UTC')`;
const activityExpiry = sql`${activityClock} + interval '24 hours'`;
export type ActivityTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type ActivitySnapshot = typeof runActivitySnapshots.$inferSelect;

export async function activityTransaction<T>(
  db: Db,
  work: (tx: ActivityTx) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '250ms'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    return await work(tx);
  });
}

export async function activityEnabled(
  db: Pick<Db, "select">,
  orgId: string,
  userId: string,
): Promise<boolean> {
  return isFeatureEnabled(
    FeatureSwitchKey.ThreadActivitySummary,
    await loadUserFeatureSwitchContext(db, orgId, userId),
  );
}

export interface ActivityRunIdentity {
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
}

/** Admission binds this pointer atomically; queued work does not replace it. */
export function eligibleActivityRun(
  db: Pick<Db, "select">,
  identity: ActivityRunIdentity,
) {
  return db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
    .where(
      and(
        eq(agentRuns.id, identity.runId),
        eq(agentRuns.chatThreadId, identity.threadId),
        eq(agentRuns.userId, identity.userId),
        eq(agentRuns.orgId, identity.orgId),
        eq(chatThreads.userId, identity.userId),
        chatThreadOrganizationCondition(db, identity.orgId),
        eq(chatThreads.agentSessionRunId, identity.runId),
        inArray(agentRuns.status, ["pending", "running"]),
      ),
    );
}

export async function lockActivitySnapshot(tx: ActivityTx, runId: string) {
  await tx.insert(runActivitySnapshots).values({ runId }).onConflictDoNothing();
  const [row] = await tx
    .select({
      ...getTableColumns(runActivitySnapshots),
      clock: activityClock.mapWith(runActivitySnapshots.expiresAt),
    })
    .from(runActivitySnapshots)
    .where(eq(runActivitySnapshots.runId, runId))
    .for("update");
  if (!row) {
    throw new Error(SNAPSHOT_MISSING);
  }
  return row;
}

export const captureRunActivity$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const payload = get(eventConsumerPayload$);
    const db = set(writeDb$);
    let stage: CaptureStage = "admission";
    const outcome = await settleIncludingAbort(
      activityTransaction(db, async (tx) => {
        const [run] = await tx
          .select({
            threadId: agentRuns.chatThreadId,
            userId: agentRuns.userId,
            orgId: agentRuns.orgId,
          })
          .from(agentRuns)
          .where(eq(agentRuns.id, payload.runId));
        if (
          !run?.threadId ||
          run.userId !== payload.context.userId ||
          run.orgId !== payload.context.orgId
        ) {
          return "ineligible";
        }
        if (!(await activityEnabled(tx, run.orgId, run.userId))) {
          return "disabled";
        }
        const identity = {
          ...run,
          threadId: run.threadId,
          runId: payload.runId,
        };
        if (!(await eligibleActivityRun(tx, identity))[0]) {
          return "ineligible";
        }
        if (mergeActivity([], payload.events).length === 0) {
          return "irrelevant";
        }
        signal.throwIfAborted();
        stage = "lock";
        const row = await lockActivitySnapshot(tx, payload.runId);
        const expired = row.expiresAt <= row.clock;
        const entries = mergeActivity(
          expired ? [] : row.entries,
          payload.events,
        );
        const revision = activityRevision(entries);
        if (!expired && revision === row.activityRevision) {
          return "unchanged";
        }
        stage = "persist";
        await tx
          .update(runActivitySnapshots)
          .set({
            entries,
            activityRevision: revision,
            expiresAt: activityExpiry,
            ...(expired
              ? {
                  summary: null,
                  summaryRevision: null,
                  summarySequence: null,
                  summaryMessageCursor: null,
                  summarizedAt: null,
                  claimId: null,
                  claimRevision: null,
                  claimExpiresAt: null,
                }
              : {}),
          })
          .where(eq(runActivitySnapshots.runId, payload.runId));
        stage = "commit";
        return "written";
      }),
    );
    signal.throwIfAborted();
    if (
      outcome.ok &&
      ["disabled", "irrelevant", "ineligible"].includes(outcome.value)
    ) {
      return { status: 200 };
    }
    if (outcome.ok) {
      log.info("Activity snapshot capture", {
        runId: payload.runId,
        outcome: outcome.value,
        eventCount: payload.events.length,
      });
      return { status: 200 };
    }
    // Never attach a database error: driver messages can include bound evidence.
    // The SQLSTATE class code and the stage carry no content and stay.
    const failure = captureFailure(outcome.error);
    const errorCode = safeSqlStateCode(outcome.error);
    const capture = {
      runId: payload.runId,
      outcome: failure,
      eventCount: payload.events.length,
      stage,
      ...(errorCode === undefined ? {} : { errorCode }),
    };
    if (isExpectedFailure(failure)) {
      log.info("Activity snapshot capture", capture);
    } else {
      log.warn("Activity snapshot capture", capture);
    }
    return { status: 200 };
  },
);

/** Indexed, one-batch maintenance; disabled accounts still get expiry cleanup. */
export const cleanupExpiredRunActivity$ = command(
  async ({ set }, runIds: readonly string[] | null, signal: AbortSignal) => {
    const db = set(writeDb$);
    const outcome = await settleIncludingAbort(
      activityTransaction(db, async (tx) => {
        const expired = await tx
          .select({ runId: runActivitySnapshots.runId })
          .from(runActivitySnapshots)
          .where(
            and(
              lte(runActivitySnapshots.expiresAt, activityClock),
              runIds === null
                ? undefined
                : inArray(runActivitySnapshots.runId, runIds),
            ),
          )
          .orderBy(
            asc(runActivitySnapshots.expiresAt),
            asc(runActivitySnapshots.runId),
          )
          .limit(500)
          .for("update", { skipLocked: true });
        signal.throwIfAborted();
        if (expired.length === 0) {
          return 0;
        }
        const removed = await tx
          .delete(runActivitySnapshots)
          .where(
            inArray(
              runActivitySnapshots.runId,
              expired.map((row) => {
                return row.runId;
              }),
            ),
          )
          .returning({ runId: runActivitySnapshots.runId });
        return removed.length;
      }),
    );
    signal.throwIfAborted();
    if (outcome.ok) {
      log.info("Activity snapshot cleanup", {
        outcome: "success",
        removed: outcome.value,
        retentionMs: ACTIVITY_RETENTION_MS,
      });
      return;
    }
    const errorCode = safeSqlStateCode(outcome.error);
    log.warn("Activity snapshot cleanup", {
      outcome: "failed",
      removed: 0,
      retentionMs: ACTIVITY_RETENTION_MS,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  },
);
