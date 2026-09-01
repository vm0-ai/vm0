import { agentRuns } from "@okouai/db/schema/agent-run";
import { officialAutomationResultEmailClaims } from "@okouai/db/schema/official-automation-result-email-claim";
import { userCache } from "@okouai/db/schema/user-cache";
import { users } from "@okouai/db/schema/user";
import { workflows } from "@okouai/db/schema/workflow";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { nowDate } from "../lib/time";
import { createDeferredPromise } from "../signals/utils";

const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });

export async function clearResultEmailUserStateFixture(
  userId: string,
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx.delete(userCache).where(eq(userCache.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });
}

export async function readResultEmailPreferenceFixture(
  userId: string,
): Promise<boolean | null> {
  const [preference] = await db()
    .select({ emailUnsubscribed: users.emailUnsubscribed })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return preference?.emailUnsubscribed ?? null;
}

export async function completeResultEmailRunWithoutCallbacksFixture(
  runId: string,
): Promise<void> {
  const rows = await db()
    .update(agentRuns)
    .set({ status: "completed", completedAt: nowDate() })
    .where(eq(agentRuns.id, runId))
    .returning({ id: agentRuns.id });
  if (rows.length !== 1) {
    throw new Error("Expected one result-email Run to complete");
  }
}

export async function markWorkflowAsMorningBriefResultEmailFixture(
  workflowId: string,
): Promise<void> {
  const rows = await db()
    .update(workflows)
    .set({
      name: "morning-brief",
      visibility: "private",
      instruction: null,
      displayName: null,
      description: null,
      officialDefinitionName: "morning-brief",
      officialInstallationState: "installed",
      updatedAt: nowDate(),
    })
    .where(eq(workflows.id, workflowId))
    .returning({ id: workflows.id });
  if (rows.length !== 1) {
    throw new Error(
      "Expected one result-email Workflow to become Morning Brief",
    );
  }
}

interface HeldResultEmailClaimBoundary {
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
  readonly blockedChainCount: () => Promise<number>;
}

async function directBlockedWaiterCount(holderPid: number): Promise<number> {
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
}

async function blockedChainCount(holderPid: number): Promise<number> {
  const rows = await executeRawRows(
    db(),
    sql`
      WITH RECURSIVE blocked(pid) AS (
        SELECT activity.pid
        FROM pg_stat_activity AS activity
        WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
        UNION
        SELECT activity.pid
        FROM pg_stat_activity AS activity
        INNER JOIN blocked AS blocker
          ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
      )
      SELECT ${count()}::int AS "waiterCount"
      FROM blocked
    `,
    waiterCountRowSchema,
  );
  return rows[0]?.waiterCount ?? 0;
}

/**
 * Hold an uncommitted producer claim, then remove it before commit. A real
 * callback can acquire the user preference lock and wait on this unique key,
 * exposing the enqueue-first side of the preference serialization protocol.
 */
export async function holdResultEmailClaimBoundaryFixture(args: {
  readonly runId: string;
  readonly workflowAutomationId: string;
  readonly signal: AbortSignal;
}): Promise<HeldResultEmailClaimBoundary> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const pidRows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const pid = pidRows[0]?.pid;
    if (!pid) {
      throw new Error("Expected a result-email fixture backend pid");
    }
    await tx.insert(officialAutomationResultEmailClaims).values({
      runId: args.runId,
      workflowAutomationId: args.workflowAutomationId,
    });
    started.resolve(pid);
    await released.promise;
    await tx
      .delete(officialAutomationResultEmailClaims)
      .where(
        and(
          eq(officialAutomationResultEmailClaims.runId, args.runId),
          eq(
            officialAutomationResultEmailClaims.workflowAutomationId,
            args.workflowAutomationId,
          ),
        ),
      );
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
      return await directBlockedWaiterCount(holderPid);
    },
    blockedChainCount: async () => {
      return await blockedChainCount(holderPid);
    },
  };
}
