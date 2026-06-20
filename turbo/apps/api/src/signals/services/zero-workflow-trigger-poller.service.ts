import { agentRuns } from "@vm0/db/schema/agent-run";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import {
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { and, eq, isNotNull, lte } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { now, nowDate } from "../external/time";
import { settle } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { calculateNextRun } from "./automations/time-trigger";
import {
  GOAL_TRIGGER_INACTIVE_EVENT_ID,
  appendGoalStateMarker,
} from "./zero-chat-goal-marker.service";
import {
  buildChatOnlyWorkflowTriggerCallbacks,
  runWorkflowTriggerNow$,
  type DueWorkflowTrigger,
  type RunFailure,
  type RunWorkflowTriggerResult,
  type TriggerRow,
} from "./zero-workflow-trigger-run.service";

const log = logger("api:zero-workflow-trigger-poller");

const MAX_CONSECUTIVE_FAILURES = 3;
const DUE_BATCH_LIMIT = 200;

interface ExecuteResult {
  readonly executed: number;
  readonly skipped: number;
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

  await db
    .update(zeroWorkflowTriggers)
    .set({
      consecutiveFailures: newFailureCount,
      ...(shouldDisable ? { enabled: false } : {}),
      nextRunAt,
      updatedAt: failureTime,
    })
    .where(eq(zeroWorkflowTriggers.id, trigger.id));
  signal.throwIfAborted();

  if (shouldDisable) {
    log.warn("Workflow trigger auto-disabled after consecutive failures", {
      ...context,
      consecutiveFailures: newFailureCount,
    });
    // Auto-disabling a goal's thread-idle trigger is a trigger→inactive
    // transition; publish it into the thread so the composer's folded goal
    // state reflects the pause.
    if (trigger.chatThreadId && trigger.eventType === "thread-idle") {
      const [workflow] = await db
        .select({ type: zeroWorkflows.type })
        .from(zeroWorkflows)
        .where(eq(zeroWorkflows.id, trigger.workflowId))
        .limit(1);
      if (workflow?.type === "goal") {
        await appendGoalStateMarker(db, {
          chatThreadId: trigger.chatThreadId,
          eventId: GOAL_TRIGGER_INACTIVE_EVENT_ID,
          objective: null,
        });
        await publishChatThreadMessageCreatedSafely(
          trigger.ownerUserId,
          trigger.chatThreadId,
        );
      }
    }
  }
}

/**
 * Fire a one-off TEST run for a workflow schedule trigger. Same execution as a
 * scheduled fire (the workflow skill is injected via the agent's attachment and
 * the run renders in the bound thread), but it carries ONLY the chat callback —
 * no recurrence callback — and the caller does not claim or advance the
 * schedule. Used by the manual "Test run" action so authors can validate the
 * automatic entry point without disturbing `next_run_at`/`last_run_at`.
 */
export const fireWorkflowTriggerTestRun$ = command(
  async (
    { set },
    args: {
      readonly trigger: TriggerRow;
      readonly workflowName: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<RunWorkflowTriggerResult> => {
    return await set(
      runWorkflowTriggerNow$,
      {
        due: { trigger: args.trigger, workflowName: args.workflowName },
        apiStartTime: args.apiStartTime,
        // Chat callback only: a test run must not advance the schedule.
        callbacks: buildChatOnlyWorkflowTriggerCallbacks(args.trigger),
        recordLastRunId: false,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    );
  },
);

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
        workflowName: zeroWorkflows.name,
      })
      .from(zeroWorkflowTriggers)
      .innerJoin(
        zeroWorkflows,
        eq(zeroWorkflowTriggers.workflowId, zeroWorkflows.id),
      )
      .where(
        and(
          eq(zeroWorkflowTriggers.enabled, true),
          eq(zeroWorkflowTriggers.kind, "schedule"),
          eq(zeroWorkflows.type, "workflow"),
          isNotNull(zeroWorkflowTriggers.agentId),
          isNotNull(zeroWorkflowTriggers.chatThreadId),
          lte(zeroWorkflowTriggers.nextRunAt, currentTime),
        ),
      )
      .limit(DUE_BATCH_LIMIT);
    signal.throwIfAborted();

    let executed = 0;
    let skipped = 0;

    for (const row of rows) {
      const due: DueWorkflowTrigger = {
        trigger: row.trigger,
        workflowName: row.workflowName,
      };

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
