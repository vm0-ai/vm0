import { agentRuns } from "@vm0/db/schema/agent-run";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import {
  workflowUserTriggerThreads,
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { and, eq, lte } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import { settle } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { calculateNextRun } from "./automations/time-trigger";
import {
  runWorkflowTriggerNow$,
  type DueWorkflowTrigger,
  type RunFailure,
  type TriggerRow,
} from "./zero-workflow-trigger-run.service";
import { ensureWorkflowUserTriggerThread } from "./zero-workflow-user-trigger-thread.service";

const log = logger("api:zero-workflow-trigger-poller");

const MAX_CONSECUTIVE_FAILURES = 3;
const DUE_BATCH_LIMIT = 200;

interface ExecuteResult {
  readonly executed: number;
  readonly skipped: number;
}

interface DueWorkflowTriggerRow {
  readonly trigger: TriggerRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly workflowDisplayName: string | null;
  readonly chatThreadId: string | null;
}

function isRunFailure(error: unknown): error is RunFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    (error.kind === "conflict" || error.kind === "run_error")
  );
}

function failureMessage(error: unknown): string {
  if (!isRunFailure(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  if (error.kind === "run_error") {
    return `${error.response.status} ${error.response.body.error.code}: ${error.response.body.error.message}`;
  }
  return error.message;
}

function isInsufficientCreditsFailure(error: unknown): boolean {
  return (
    isRunFailure(error) &&
    error.kind === "run_error" &&
    error.response.body.error.code === "INSUFFICIENT_CREDITS"
  );
}

function isActivePreviousRunStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

async function hasOrgMembership(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
): Promise<boolean> {
  const [membership] = await db
    .select({ userId: orgMembersCache.userId })
    .from(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.orgId, args.orgId),
        eq(orgMembersCache.userId, args.userId),
      ),
    )
    .limit(1);
  return membership !== undefined;
}

/**
 * Claim a due workflow trigger via an optimistic lock on `next_run_at`: clear
 * the next run, stamp `last_run_at`, and disable one-time triggers. Recurrence
 * advance happens in the completion callback. Returns the claimed row, or null
 * when another tick won the race.
 */
async function claimTrigger(
  db: Db,
  trigger: TriggerRow,
  currentTime: Date,
): Promise<TriggerRow | null> {
  if (!trigger.nextRunAt) {
    return null;
  }
  const [claimed] = await db
    .update(zeroWorkflowTriggers)
    .set({
      nextRunAt: null,
      lastRunAt: currentTime,
      updatedAt: currentTime,
      ...(trigger.scheduleType === "once" ? { enabled: false } : {}),
    })
    .where(
      and(
        eq(zeroWorkflowTriggers.id, trigger.id),
        eq(zeroWorkflowTriggers.nextRunAt, trigger.nextRunAt),
      ),
    )
    .returning();
  return claimed ?? null;
}

function advanceAfterPreRunFailure(
  trigger: TriggerRow,
  failureTime: Date,
  shouldDisable: boolean,
): Date | null {
  if (shouldDisable) {
    return null;
  }
  if (trigger.scheduleType === "cron" && trigger.cronExpression) {
    return calculateNextRun(
      trigger.cronExpression,
      trigger.timezone,
      failureTime,
    );
  }
  if (trigger.scheduleType === "loop" && trigger.intervalSeconds) {
    return new Date(failureTime.getTime() + trigger.intervalSeconds * 1000);
  }
  return null;
}

async function recordPreRunFailure(
  db: Db,
  trigger: TriggerRow,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  const isCreditError = isInsufficientCreditsFailure(error);
  const context = {
    triggerId: trigger.id,
    workflowId: trigger.workflowId,
    orgId: trigger.orgId,
    userId: trigger.ownerUserId,
    error: failureMessage(error),
  };
  if (isCreditError) {
    log.warn("Workflow trigger skipped: insufficient credits", context);
  } else {
    log.error("Workflow trigger pre-run failed", context);
  }

  const failureTime = nowDate();
  const newFailureCount = trigger.consecutiveFailures + 1;
  const shouldDisable = newFailureCount >= MAX_CONSECUTIVE_FAILURES;
  const nextRunAt = advanceAfterPreRunFailure(
    trigger,
    failureTime,
    shouldDisable,
  );
  const triggerIsStillEligible =
    trigger.scheduleType === "once"
      ? eq(zeroWorkflowTriggers.id, trigger.id)
      : and(
          eq(zeroWorkflowTriggers.id, trigger.id),
          eq(zeroWorkflowTriggers.enabled, true),
        );

  await db
    .update(zeroWorkflowTriggers)
    .set({
      consecutiveFailures: newFailureCount,
      ...(shouldDisable ? { enabled: false } : {}),
      nextRunAt,
      updatedAt: failureTime,
    })
    .where(triggerIsStillEligible);
  signal.throwIfAborted();

  if (shouldDisable) {
    log.warn("Workflow trigger auto-disabled after consecutive failures", {
      ...context,
      consecutiveFailures: newFailureCount,
    });
  }
}

async function ensureDueWorkflowTriggerChatThread(
  db: Db,
  row: DueWorkflowTriggerRow,
  currentTime: Date,
): Promise<string> {
  if (row.chatThreadId) {
    return row.chatThreadId;
  }
  return await db.transaction(async (tx) => {
    return await ensureWorkflowUserTriggerThread(tx, {
      orgId: row.trigger.orgId,
      userId: row.trigger.ownerUserId,
      workflowId: row.trigger.workflowId,
      agentId: row.agentId,
      workflowTitle: row.workflowDisplayName ?? row.workflowName,
      currentTime,
    });
  });
}

/**
 * Time poller over `zero_workflow_triggers`, run from the
 * execute-workflow-triggers cron route. Mirrors the automation poller: scan
 * enabled triggers whose `next_run_at` is due, skip any whose previous run is
 * still active, optimistic-lock claim the due row, then fire a run that injects
 * the workflow skill (via the agent's attachment) and carries the recurrence
 * completion callback.
 */
export const executeDueWorkflowTriggers$ = command(
  async ({ set }, signal: AbortSignal): Promise<ExecuteResult> => {
    const db = set(writeDb$);
    const currentTime = nowDate();

    const rows = await db
      .select({
        trigger: zeroWorkflowTriggers,
        agentId: zeroWorkflows.agentId,
        workflowName: zeroWorkflows.name,
        workflowDisplayName: zeroWorkflows.displayName,
        chatThreadId: workflowUserTriggerThreads.chatThreadId,
      })
      .from(zeroWorkflowTriggers)
      .innerJoin(
        zeroWorkflows,
        eq(zeroWorkflowTriggers.workflowId, zeroWorkflows.id),
      )
      .leftJoin(
        workflowUserTriggerThreads,
        and(
          eq(workflowUserTriggerThreads.orgId, zeroWorkflowTriggers.orgId),
          eq(
            workflowUserTriggerThreads.userId,
            zeroWorkflowTriggers.ownerUserId,
          ),
          eq(
            workflowUserTriggerThreads.workflowId,
            zeroWorkflowTriggers.workflowId,
          ),
        ),
      )
      .where(
        and(
          eq(zeroWorkflowTriggers.enabled, true),
          eq(zeroWorkflowTriggers.kind, "schedule"),
          lte(zeroWorkflowTriggers.nextRunAt, currentTime),
        ),
      )
      .limit(DUE_BATCH_LIMIT);
    signal.throwIfAborted();

    let executed = 0;
    let skipped = 0;

    for (const row of rows) {
      const ownerIsMember = await hasOrgMembership(db, {
        orgId: row.trigger.orgId,
        userId: row.trigger.ownerUserId,
      });
      signal.throwIfAborted();
      if (!ownerIsMember) {
        log.warn(
          "Disabling workflow trigger: owner is no longer an org member",
          {
            triggerId: row.trigger.id,
            orgId: row.trigger.orgId,
            userId: row.trigger.ownerUserId,
          },
        );
        await db
          .update(zeroWorkflowTriggers)
          .set({ enabled: false, nextRunAt: null, updatedAt: currentTime })
          .where(eq(zeroWorkflowTriggers.id, row.trigger.id));
        signal.throwIfAborted();
        skipped++;
        continue;
      }

      if (row.trigger.lastRunId) {
        const [lastRun] = await db
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, row.trigger.lastRunId))
          .limit(1);
        signal.throwIfAborted();
        if (lastRun && isActivePreviousRunStatus(lastRun.status)) {
          skipped++;
          continue;
        }
      }

      const claimed = await claimTrigger(db, row.trigger, currentTime);
      signal.throwIfAborted();
      if (!claimed) {
        skipped++;
        continue;
      }

      const chatThreadId = await ensureDueWorkflowTriggerChatThread(
        db,
        row,
        currentTime,
      );
      signal.throwIfAborted();

      const due: DueWorkflowTrigger = {
        trigger: claimed,
        agentId: row.agentId,
        workflowName: row.workflowName,
        chatThreadId,
      };

      const runResult = await settle(
        set(
          runWorkflowTriggerNow$,
          {
            due,
            apiStartTime: now(),
            dispatchFailedCallbacks: dispatchFailedRunCallbacks,
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      if (!runResult.ok) {
        await recordPreRunFailure(db, claimed, runResult.error, signal);
        skipped++;
        continue;
      }
      const result = runResult.value;
      if (result.kind !== "ok") {
        await recordPreRunFailure(db, claimed, result, signal);
        skipped++;
        continue;
      }
      executed++;
    }

    log.debug("execute-workflow-triggers tick complete", {
      dueCount: rows.length,
      executed,
      skipped,
    });
    return { executed, skipped };
  },
);
