import { command } from "ccstate";
import { and, count, eq, inArray, lte, sql } from "drizzle-orm";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { runBuiltInAdmissions } from "@okouai/db/schema/run-built-in-admission";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  insertRunUsageEvent,
  publishRunUsageEvent,
  type InsertedRunUsageEvent,
} from "./chat-usage-event.service";
import { processOrgUsageEvents$ } from "./credit-usage.service";

const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;

type FinalizationReadiness =
  | { readonly kind: "not-found" }
  | { readonly kind: "waiting" }
  | { readonly kind: "finalized" }
  | { readonly kind: "ready"; readonly orgId: string };

interface FinalizationCommit {
  readonly finalized: boolean;
  readonly emitted: InsertedRunUsageEvent | null;
}

async function expireRunBuiltInAdmissions(
  tx: Tx,
  runId: string,
): Promise<void> {
  const now = nowDate();
  await tx
    .update(runBuiltInAdmissions)
    .set({ status: "expired", completedAt: now, updatedAt: now })
    .where(
      and(
        eq(runBuiltInAdmissions.runId, runId),
        eq(runBuiltInAdmissions.status, "active"),
        lte(runBuiltInAdmissions.expiresAt, now),
      ),
    );
}

async function lockRunBuiltInFinalization(
  tx: Tx,
  runId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('run_builtin_' || ${runId}))`,
  );
}

async function hasActiveRunBuiltInAdmission(
  tx: Tx,
  runId: string,
): Promise<boolean> {
  const [result] = await tx
    .select({ total: count() })
    .from(runBuiltInAdmissions)
    .where(
      and(
        eq(runBuiltInAdmissions.runId, runId),
        eq(runBuiltInAdmissions.status, "active"),
      ),
    );
  return Number(result?.total ?? 0) > 0;
}

async function loadFinalizationReadiness(
  tx: Tx,
  runId: string,
): Promise<FinalizationReadiness> {
  await lockRunBuiltInFinalization(tx, runId);
  await expireRunBuiltInAdmissions(tx, runId);

  const [run] = await tx
    .select({
      orgId: agentRuns.orgId,
      status: agentRuns.status,
      usageFinalizationState: agentRuns.usageFinalizationState,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("update", { of: agentRuns })
    .limit(1);
  if (!run) {
    return { kind: "not-found" };
  }
  if (run.usageFinalizationState === "finalized") {
    return { kind: "finalized" };
  }
  if (
    run.usageFinalizationState !== "deliveryFinalized" ||
    !TERMINAL_RUN_STATUSES.includes(
      run.status as (typeof TERMINAL_RUN_STATUSES)[number],
    ) ||
    (await hasActiveRunBuiltInAdmission(tx, runId))
  ) {
    return { kind: "waiting" };
  }
  return { kind: "ready", orgId: run.orgId };
}

async function commitRunUsageFinalization(
  tx: Tx,
  runId: string,
  signal: AbortSignal,
): Promise<FinalizationCommit> {
  const readiness = await loadFinalizationReadiness(tx, runId);
  signal.throwIfAborted();
  if (readiness.kind === "finalized") {
    return { finalized: true, emitted: null };
  }
  if (readiness.kind !== "ready") {
    return { finalized: false, emitted: null };
  }

  const [updated] = await tx
    .update(agentRuns)
    .set({ usageFinalizationState: "finalized" })
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.usageFinalizationState, "deliveryFinalized"),
        inArray(agentRuns.status, TERMINAL_RUN_STATUSES),
      ),
    )
    .returning({ id: agentRuns.id });
  if (!updated) {
    throw new Error("Locked agent run lost its usage finalization transition");
  }

  const emitted = await insertRunUsageEvent(tx, runId, signal);
  return { finalized: true, emitted };
}

export const finalizeRunUsage$ = command(
  async ({ set }, runId: string, signal: AbortSignal): Promise<boolean> => {
    const db = set(writeDb$);
    const readiness = await db.transaction(async (tx) => {
      return await loadFinalizationReadiness(tx, runId);
    });
    signal.throwIfAborted();
    if (readiness.kind === "not-found" || readiness.kind === "waiting") {
      return false;
    }
    if (readiness.kind === "finalized") {
      return true;
    }

    await set(processOrgUsageEvents$, readiness.orgId, signal);
    signal.throwIfAborted();

    const commit = await db.transaction(async (tx) => {
      return await commitRunUsageFinalization(tx, runId, signal);
    });
    signal.throwIfAborted();

    if (commit.emitted) {
      await publishRunUsageEvent(runId, commit.emitted, signal);
    }
    return commit.finalized;
  },
);

export const acknowledgeRunUsageDelivery$ = command(
  async (
    { set },
    args: { readonly runId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<boolean | null> => {
    const db = set(writeDb$);
    const state = await db.transaction(async (tx) => {
      const [run] = await tx
        .select({
          usageFinalizationState: agentRuns.usageFinalizationState,
        })
        .from(agentRuns)
        .where(
          and(eq(agentRuns.id, args.runId), eq(agentRuns.userId, args.userId)),
        )
        .for("update", { of: agentRuns })
        .limit(1);
      if (!run) {
        return null;
      }
      if (run.usageFinalizationState === "finalized") {
        return "finalized" as const;
      }
      if (run.usageFinalizationState !== "deliveryFinalized") {
        await tx
          .update(agentRuns)
          .set({ usageFinalizationState: "deliveryFinalized" })
          .where(
            and(
              eq(agentRuns.id, args.runId),
              eq(agentRuns.userId, args.userId),
            ),
          );
      }
      return "deliveryFinalized" as const;
    });
    signal.throwIfAborted();
    if (state === null) {
      return null;
    }
    if (state === "finalized") {
      return true;
    }
    return await set(finalizeRunUsage$, args.runId, signal);
  },
);
