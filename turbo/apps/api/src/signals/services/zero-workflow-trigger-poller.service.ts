import { randomBytes } from "node:crypto";

import { agentRuns } from "@vm0/db/schema/agent-run";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { and, eq, isNotNull, lte } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import { settle } from "../utils";
import {
  postAutomationUserMessage,
  resolveAutomationChatThreadModelPin,
} from "../routes/zero-chat-messages";
import {
  resolveModelFirstProviderAdmission,
  type ModelFirstPin,
} from "./zero-model-selection.service";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { createZeroRun$ } from "./zero-runs-create.service";
import { calculateNextRun } from "./automations/time-trigger";
import type { InternalRunCallbackKind } from "./internal-run-callback";

const log = logger("api:zero-workflow-trigger-poller");

const MAX_CONSECUTIVE_FAILURES = 3;
const DUE_BATCH_LIMIT = 200;

type TriggerRow = typeof zeroWorkflowTriggers.$inferSelect;

interface DueWorkflowTrigger {
  readonly trigger: TriggerRow;
  readonly workflowName: string;
}

interface ExecuteResult {
  readonly executed: number;
  readonly skipped: number;
}

type RunErrorResponse = {
  readonly status: number;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
};

type RunWorkflowTriggerResult =
  | { readonly kind: "ok"; readonly runId: string }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "run_error"; readonly response: RunErrorResponse };

type RunFailure = Exclude<RunWorkflowTriggerResult, { kind: "ok" }>;

interface InternalRunCallbackInput {
  readonly internalKind: InternalRunCallbackKind;
  readonly secret: string;
  readonly payload: unknown;
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function isActivePreviousRunStatus(status: string): boolean {
  return status === "pending" || status === "running";
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
 * The recurrence reschedule callback (advances `next_run_at` / failure
 * bookkeeping on completion) plus the chat callback (drives the web-chat
 * render). Cron and once both use the cron callback; once carries no
 * cronExpression so it does not recur.
 */
function buildWorkflowTriggerCallbacks(
  trigger: TriggerRow,
): InternalRunCallbackInput[] {
  const callbacks: InternalRunCallbackInput[] = [];
  if (trigger.scheduleType === "loop") {
    callbacks.push({
      internalKind: "workflow-trigger:loop",
      secret: generateCallbackSecret(),
      payload: { triggerId: trigger.id },
    });
  } else {
    callbacks.push({
      internalKind: "workflow-trigger:cron",
      secret: generateCallbackSecret(),
      payload: {
        triggerId: trigger.id,
        timezone: trigger.timezone,
        ...(trigger.cronExpression
          ? { cronExpression: trigger.cronExpression }
          : {}),
      },
    });
  }
  if (trigger.chatThreadId && trigger.agentId) {
    callbacks.push({
      internalKind: "chat",
      secret: generateCallbackSecret(),
      payload: { threadId: trigger.chatThreadId, agentId: trigger.agentId },
    });
  }
  return callbacks;
}

function buildAppendSystemPrompt(workflowName: string): string {
  return [
    "# Current context",
    `You are running on a schedule trigger for the "${workflowName}" workflow.`,
    `The workflow's procedure is available as a skill — execute it now.`,
    "This run is linked to a web chat thread; everything you output is shown to the user there.",
  ].join("\n");
}

type ModelContext =
  | {
      readonly ok: true;
      readonly modelPin: ModelFirstPin;
      readonly effectiveModelProvider: string | null | undefined;
    }
  | { readonly ok: false; readonly failure: RunFailure };

async function resolveModelContext(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly signal: AbortSignal;
}): Promise<ModelContext> {
  const threadModelPin = await resolveAutomationChatThreadModelPin({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    threadId: args.chatThreadId,
  });
  args.signal.throwIfAborted();
  if ("status" in threadModelPin) {
    return {
      ok: false,
      failure: {
        kind: "run_error",
        response: { status: 400, body: threadModelPin.body },
      },
    };
  }

  const providerAdmission = await resolveModelFirstProviderAdmission({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    modelPin: threadModelPin,
    requestedModelProvider: undefined,
  });
  args.signal.throwIfAborted();
  if (providerAdmission.error) {
    return {
      ok: false,
      failure: { kind: "run_error", response: providerAdmission.error },
    };
  }

  return {
    ok: true,
    modelPin: threadModelPin,
    effectiveModelProvider: providerAdmission.effectiveModelProvider,
  };
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
  }
}

const runWorkflowTriggerNow$ = command(
  async (
    { set },
    args: {
      readonly due: DueWorkflowTrigger;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<RunWorkflowTriggerResult> => {
    const db = set(writeDb$);
    const { trigger, workflowName } = args.due;

    if (!trigger.agentId || !trigger.chatThreadId) {
      return {
        kind: "run_error",
        response: {
          status: 400,
          body: {
            error: {
              message: "Workflow trigger is missing its agent or thread",
              code: "INVALID_TRIGGER",
            },
          },
        },
      };
    }
    const agentId = trigger.agentId;
    const chatThreadId = trigger.chatThreadId;

    if (trigger.lastRunId) {
      const [lastRun] = await db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, trigger.lastRunId))
        .limit(1);
      signal.throwIfAborted();
      if (lastRun && isActivePreviousRunStatus(lastRun.status)) {
        return { kind: "conflict", message: "Previous run is still active" };
      }
    }

    const modelContext = await resolveModelContext({
      db,
      orgId: trigger.orgId,
      userId: trigger.ownerUserId,
      chatThreadId,
      signal,
    });
    if (!modelContext.ok) {
      return modelContext.failure;
    }
    const { modelPin, effectiveModelProvider } = modelContext;

    const prompt = `/${workflowName}`;
    const result = await set(
      createZeroRun$,
      {
        auth: {
          orgId: trigger.orgId,
          orgRole: "member",
          userId: trigger.ownerUserId,
          tokenType: "session",
        },
        body: {
          prompt,
          agentId,
          ...(effectiveModelProvider
            ? { modelProvider: effectiveModelProvider }
            : {}),
        },
        apiStartTime: args.apiStartTime,
        triggerSource: "workflow-schedule",
        chatThreadId,
        modelProviderId: modelPin.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          modelPin.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: modelPin.selectedModel ?? undefined,
        appendSystemPrompt: buildAppendSystemPrompt(workflowName),
        callbacks: buildWorkflowTriggerCallbacks(trigger),
        zeroRunMetadata: {
          workflowTriggerId: trigger.id,
        },
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== 201) {
      return { kind: "run_error", response: result };
    }

    await postAutomationUserMessage({
      db,
      threadId: chatThreadId,
      userId: trigger.ownerUserId,
      runId: result.body.runId,
      prompt,
      appendQueueMarker: result.body.status === "queued",
    });
    signal.throwIfAborted();

    await db
      .update(zeroRuns)
      .set({
        modelProvider: effectiveModelProvider,
        modelProviderId: modelPin.modelProviderId,
        modelProviderCredentialScope: modelPin.modelProviderCredentialScope,
        selectedModel: modelPin.selectedModel,
      })
      .where(eq(zeroRuns.id, result.body.runId));
    signal.throwIfAborted();

    await db
      .update(zeroWorkflowTriggers)
      .set({ lastRunId: result.body.runId })
      .where(eq(zeroWorkflowTriggers.id, trigger.id));
    signal.throwIfAborted();

    return { kind: "ok", runId: result.body.runId };
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
        set(runWorkflowTriggerNow$, { due, apiStartTime: now() }, signal),
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
