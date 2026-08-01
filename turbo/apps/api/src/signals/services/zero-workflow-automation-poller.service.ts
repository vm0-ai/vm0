import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import {
  workflowUserAutomationThreads,
  zeroWorkflowAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { and, eq, lte } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import { tapError } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { calculateNextRun } from "./time-automation";
import {
  runWorkflowAutomationNow$,
  scheduleTriggerContext,
  type DueWorkflowAutomation,
  type RunFailure,
  type AutomationRow,
} from "./zero-workflow-automation-run.service";
import {
  workflowAutomationAppendSystemPrompt,
  workflowAutomationPrompt,
} from "./workflow-automation-context.service";
import { workflowAutomationCanFire } from "./zero-workflow-automation-access.service";
import { buildWorkflowScheduleAutomationBrief } from "./zero-workflow-automation-brief.service";
import { ensureWorkflowUserAutomationThread } from "./zero-workflow-user-automation-thread.service";

const log = logger("api:zero-workflow-automation-poller");

const MAX_CONSECUTIVE_FAILURES = 3;
const DUE_BATCH_LIMIT = 200;

interface ExecuteResult {
  readonly executed: number;
  readonly skipped: number;
}

interface DueWorkflowAutomationRow {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly workflowDisplayName: string | null;
  readonly chatThreadId: string | null;
  readonly userTimezone: string | null;
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
 * Claim a due workflow automation via an optimistic lock on `next_run_at`: clear
 * the next run and stamp `last_run_at`. A one-time automation stays readable
 * until its queued event claims a run, so a draining previous API version does
 * not discard the event during rollout. Recurrence advance happens in the
 * completion callback. Returns the claimed row, or null when another tick won
 * the race.
 */
async function claimAutomation(
  db: Db,
  automation: AutomationRow,
  currentTime: Date,
): Promise<AutomationRow | null> {
  if (!automation.nextRunAt) {
    return null;
  }
  const [claimed] = await db
    .update(zeroWorkflowAutomations)
    .set({
      nextRunAt: null,
      lastRunAt: currentTime,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(zeroWorkflowAutomations.id, automation.id),
        eq(zeroWorkflowAutomations.nextRunAt, automation.nextRunAt),
      ),
    )
    .returning();
  return claimed ?? null;
}

function advanceAfterPreRunFailure(
  automation: AutomationRow,
  failureTime: Date,
  shouldDisable: boolean,
): Date | null {
  if (shouldDisable) {
    return null;
  }
  if (automation.scheduleType === "cron" && automation.cronExpression) {
    return calculateNextRun(
      automation.cronExpression,
      automation.timezone,
      failureTime,
    );
  }
  if (automation.scheduleType === "loop" && automation.intervalSeconds) {
    return new Date(failureTime.getTime() + automation.intervalSeconds * 1000);
  }
  return null;
}

async function recordPreRunFailure(
  db: Db,
  automation: AutomationRow,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  const isCreditError = isInsufficientCreditsFailure(error);
  const context = {
    automationId: automation.id,
    workflowId: automation.workflowId,
    orgId: automation.orgId,
    userId: automation.ownerUserId,
    error: failureMessage(error),
  };
  if (isCreditError) {
    log.warn("Workflow automation skipped: insufficient credits", context);
  } else {
    log.error("Workflow automation pre-run failed", context);
  }

  const failureTime = nowDate();
  const newFailureCount = automation.consecutiveFailures + 1;
  const shouldDisable = newFailureCount >= MAX_CONSECUTIVE_FAILURES;
  const nextRunAt = advanceAfterPreRunFailure(
    automation,
    failureTime,
    shouldDisable,
  );
  const automationIsStillEligible =
    automation.scheduleType === "once"
      ? eq(zeroWorkflowAutomations.id, automation.id)
      : and(
          eq(zeroWorkflowAutomations.id, automation.id),
          eq(zeroWorkflowAutomations.enabled, true),
        );

  await db
    .update(zeroWorkflowAutomations)
    .set({
      consecutiveFailures: newFailureCount,
      ...(shouldDisable ? { enabled: false } : {}),
      nextRunAt,
      updatedAt: failureTime,
    })
    .where(automationIsStillEligible);
  signal.throwIfAborted();

  if (shouldDisable) {
    log.warn("Workflow automation auto-disabled after consecutive failures", {
      ...context,
      consecutiveFailures: newFailureCount,
    });
  }
}

async function ensureDueWorkflowAutomationChatThread(
  db: Db,
  row: DueWorkflowAutomationRow,
  currentTime: Date,
): Promise<string> {
  if (row.chatThreadId) {
    return row.chatThreadId;
  }
  return await db.transaction(async (tx) => {
    return await ensureWorkflowUserAutomationThread(tx, {
      orgId: row.automation.orgId,
      userId: row.automation.ownerUserId,
      workflowId: row.automation.workflowId,
      agentId: row.agentId,
      workflowTitle: row.workflowDisplayName ?? row.workflowName,
      currentTime,
    });
  });
}

async function dueWorkflowAutomationRows(
  db: Db,
  currentTime: Date,
  signal: AbortSignal,
): Promise<DueWorkflowAutomationRow[]> {
  const rows = await db
    .select({
      automation: zeroWorkflowAutomations,
      agentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
      workflowDisplayName: zeroWorkflows.displayName,
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
      userTimezone: orgMembersMetadata.timezone,
    })
    .from(zeroWorkflowAutomations)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflowAutomations.workflowId, zeroWorkflows.id),
    )
    .leftJoin(
      workflowUserAutomationThreads,
      and(
        eq(workflowUserAutomationThreads.orgId, zeroWorkflowAutomations.orgId),
        eq(
          workflowUserAutomationThreads.userId,
          zeroWorkflowAutomations.ownerUserId,
        ),
        eq(
          workflowUserAutomationThreads.workflowId,
          zeroWorkflowAutomations.workflowId,
        ),
      ),
    )
    .leftJoin(
      orgMembersMetadata,
      and(
        eq(orgMembersMetadata.orgId, zeroWorkflowAutomations.orgId),
        eq(orgMembersMetadata.userId, zeroWorkflowAutomations.ownerUserId),
      ),
    )
    .where(
      and(
        eq(zeroWorkflowAutomations.enabled, true),
        eq(zeroWorkflowAutomations.kind, "schedule"),
        lte(zeroWorkflowAutomations.nextRunAt, currentTime),
      ),
    )
    .limit(DUE_BATCH_LIMIT);
  signal.throwIfAborted();
  return rows;
}

/**
 * Time poller over `zero_workflow_automations`, run from the
 * execute-workflow-automations cron route. Mirrors the automation poller: scan
 * enabled automations whose `next_run_at` is due, optimistic-lock claim the due
 * row, then fire a run that injects
 * the workflow skill (via the agent's attachment) and carries the recurrence
 * completion callback.
 */
export const executeDueWorkflowAutomations$ = command(
  async ({ set }, signal: AbortSignal): Promise<ExecuteResult> => {
    const db = set(writeDb$);
    const currentTime = nowDate();

    const rows = await dueWorkflowAutomationRows(db, currentTime, signal);
    let executed = 0;
    let skipped = 0;

    for (const row of rows) {
      const ownerIsMember = await hasOrgMembership(db, {
        orgId: row.automation.orgId,
        userId: row.automation.ownerUserId,
      });
      signal.throwIfAborted();
      if (!ownerIsMember) {
        log.warn(
          "Disabling workflow automation: owner is no longer an org member",
          {
            automationId: row.automation.id,
            orgId: row.automation.orgId,
            userId: row.automation.ownerUserId,
          },
        );
        await db
          .update(zeroWorkflowAutomations)
          .set({ enabled: false, nextRunAt: null, updatedAt: currentTime })
          .where(eq(zeroWorkflowAutomations.id, row.automation.id));
        signal.throwIfAborted();
        skipped++;
        continue;
      }

      const canFire = await workflowAutomationCanFire(db, {
        automation: row.automation,
        agentId: row.agentId,
        signal,
      });
      signal.throwIfAborted();
      if (!canFire) {
        log.debug("Workflow automation skipped: automation is paused", {
          automationId: row.automation.id,
          workflowId: row.automation.workflowId,
          agentId: row.agentId,
          orgId: row.automation.orgId,
          userId: row.automation.ownerUserId,
        });
        skipped++;
        continue;
      }

      const claimed = await claimAutomation(db, row.automation, currentTime);
      signal.throwIfAborted();
      if (!claimed) {
        skipped++;
        continue;
      }

      const chatThreadId = await ensureDueWorkflowAutomationChatThread(
        db,
        row,
        currentTime,
      );
      signal.throwIfAborted();

      const due: DueWorkflowAutomation = {
        automation: claimed,
        agentId: row.agentId,
        workflowName: row.workflowName,
        chatThreadId,
        allowClaimedOnceScheduleAutomation: claimed.scheduleType === "once",
      };

      // The tick owns the fire time, so it builds the trigger line here rather
      // than letting a later drain guess it from its own clock.
      const scheduleContext = scheduleTriggerContext({
        automation: claimed,
        workflowName: row.workflowName,
        firedAt: currentTime,
      });
      const result = await tapError(
        set(
          runWorkflowAutomationNow$,
          {
            due,
            automationContext: scheduleContext,
            apiStartTime: now(),
            prompt: workflowAutomationPrompt(scheduleContext),
            appendSystemPrompt:
              workflowAutomationAppendSystemPrompt(scheduleContext),
            triggerBrief:
              buildWorkflowScheduleAutomationBrief({
                createdAt: currentTime,
                scheduleType: claimed.scheduleType,
                cronExpression: claimed.cronExpression,
                intervalSeconds: claimed.intervalSeconds,
                atTime: claimed.atTime,
                automationTimezone: claimed.timezone,
                userTimezone: row.userTimezone,
              }) ?? undefined,
            dispatchFailedCallbacks: dispatchFailedRunCallbacks,
          },
          signal,
        ),
        async (error) => {
          await recordPreRunFailure(db, claimed, error, signal);
          skipped++;
        },
      );
      signal.throwIfAborted();
      if (!result) {
        continue;
      }
      if (result.kind === "enqueued") {
        executed++;
        continue;
      }
      if (result.kind !== "ok") {
        await recordPreRunFailure(db, claimed, result, signal);
        skipped++;
        continue;
      }
      executed++;
    }

    log.debug("execute-workflow-automations tick complete", {
      dueCount: rows.length,
      executed,
      skipped,
    });
    return { executed, skipped };
  },
);
