import { agentRuns } from "@vm0/db/schema/agent-run";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { command } from "ccstate";
import { and, eq, inArray, lte } from "drizzle-orm";

import { logger } from "../../../lib/log";
import { writeDb$, type Db } from "../../external/db";
import { now, nowDate } from "../../external/time";
import { settle } from "../../utils";
import {
  postAutomationUserMessage,
  resolveScheduleChatThreadModelPin,
} from "../../routes/zero-chat-messages";
import {
  resolveModelFirstProviderAdmission,
  type ModelFirstPin,
} from "../zero-model-selection.service";
import { createZeroRun$ } from "../zero-runs-create.service";
import {
  automationRowToTimeAutomation,
  DefaultInterpreter,
} from "./default-interpreter";
import { TimeTrigger } from "./time-trigger";

const log = logger("api:automations:trigger-poller");

const MAX_CONSECUTIVE_FAILURES = 3;

/** The time-trigger kinds the poller scans; webhook triggers are not time-driven. */
const TIME_TRIGGER_KINDS = ["cron", "once", "loop"] as const;

type TriggerRow = typeof automationTriggers.$inferSelect;

/**
 * The trigger row joined with its owning automation: everything the poller needs
 * to claim the recurrence (trigger columns) and build the run (automation
 * identity + instruction + linked thread). Mirrors the schedule row the live
 * poller reads, split across the two events-first tables.
 */
interface DueTrigger {
  readonly trigger: TriggerRow;
  readonly automation: {
    readonly id: string;
    readonly agentId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
    readonly instruction: string;
  };
}

interface ExecuteDueTriggersResult {
  readonly executed: number;
  readonly skipped: number;
}

type RunTriggerErrorResponse = {
  readonly status: 400 | 402 | 403 | 404 | 429 | 503;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
};

type RunTriggerNowResult =
  | { readonly kind: "ok"; readonly runId: string }
  | { readonly kind: "not_found"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "run_error"; readonly response: RunTriggerErrorResponse };

type RunTriggerFailure = Exclude<RunTriggerNowResult, { kind: "ok" }>;

type TriggerRunModelContext =
  | {
      readonly ok: true;
      readonly modelPin: ModelFirstPin;
      readonly effectiveModelProvider: string | null | undefined;
    }
  | { readonly ok: false; readonly failure: RunTriggerFailure };

function isActivePreviousRunStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

function isRunTriggerFailure(error: unknown): error is RunTriggerFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    (error.kind === "not_found" ||
      error.kind === "conflict" ||
      error.kind === "run_error")
  );
}

function triggerFailureMessage(error: unknown): string {
  if (!isRunTriggerFailure(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  if (error.kind === "run_error") {
    return `${error.response.status} ${error.response.body.error.code}: ${error.response.body.error.message}`;
  }
  return error.message;
}

function isInsufficientCreditsFailure(error: unknown): boolean {
  return (
    isRunTriggerFailure(error) &&
    error.kind === "run_error" &&
    error.response.body.error.code === "INSUFFICIENT_CREDITS"
  );
}

// Resolve the model context for a triggered run: the linked thread's model pin
// (org default if unpinned) and the admitted provider. No user is present to
// receive a model-config / credits error, so failures surface as run_error
// (normalized to 400) feeding consecutiveFailures — the schedule poller's policy.
async function resolveTriggerRunModelContext(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly signal: AbortSignal;
}): Promise<TriggerRunModelContext> {
  const threadModelPin = await resolveScheduleChatThreadModelPin({
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

async function recordTriggerPreRunFailure(
  db: Db,
  due: DueTrigger,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  const isCreditError = isInsufficientCreditsFailure(error);
  const failureMessage = triggerFailureMessage(error);
  const failureContext = {
    triggerId: due.trigger.id,
    automationId: due.automation.id,
    orgId: due.automation.orgId,
    userId: due.automation.userId,
    error: failureMessage,
    stack: error instanceof Error ? error.stack : undefined,
  };
  if (isCreditError) {
    log.warn("Trigger skipped: insufficient credits", failureContext);
  } else {
    log.error("Trigger pre-run failed", failureContext);
  }

  const failureTime = nowDate();
  const newFailureCount = due.trigger.consecutiveFailures + 1;
  const shouldDisable = newFailureCount >= MAX_CONSECUTIVE_FAILURES;
  const nextRunAt = new TimeTrigger().advanceTriggerAfterPreRunFailure({
    trigger: due.trigger,
    failureTime,
    shouldDisable,
  });

  await db
    .update(automationTriggers)
    .set({
      consecutiveFailures: newFailureCount,
      ...(shouldDisable ? { enabled: false } : {}),
      nextRunAt,
      updatedAt: failureTime,
    })
    .where(eq(automationTriggers.id, due.trigger.id));
  signal.throwIfAborted();

  if (shouldDisable) {
    log.warn("Trigger auto-disabled after consecutive pre-run failures", {
      triggerId: due.trigger.id,
      automationId: due.automation.id,
      orgId: due.automation.orgId,
      userId: due.automation.userId,
      consecutiveFailures: newFailureCount,
      reason: isCreditError ? "insufficient_credits" : "pre_run_failure",
    });
  }
}

// Render a triggered run as a web-chat turn in the automation's linked thread.
// Model comes from the thread pin (org default if unpinned); the session is
// always fresh (no sessionId); the run is tagged with the automation + firing
// trigger (run provenance). The claim cleared next_run_at; the interpreter
// attaches the trigger-keyed reschedule callback that advances it on completion.
const runTriggerNow$ = command(
  async (
    { set },
    args: {
      readonly due: DueTrigger;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<RunTriggerNowResult> => {
    const db = set(writeDb$);
    const { trigger, automation } = args.due;

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

    const modelContext = await resolveTriggerRunModelContext({
      db,
      orgId: automation.orgId,
      userId: automation.userId,
      chatThreadId: automation.chatThreadId,
      signal,
    });
    if (!modelContext.ok) {
      return modelContext.failure;
    }
    const { modelPin, effectiveModelProvider } = modelContext;

    // The single default interpreter handles every Automation kind, keyed off an
    // automation-table time trigger event here (provenance + trigger-keyed
    // reschedule callback). The registry is deferred to the first fetching
    // interpreter.
    const runInput = await new DefaultInterpreter().interpret(
      automationRowToTimeAutomation({
        id: automation.id,
        agentId: automation.agentId,
        orgId: automation.orgId,
        userId: automation.userId,
        chatThreadId: automation.chatThreadId,
        instruction: automation.instruction,
        triggerType: trigger.kind as "cron" | "once" | "loop",
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
      }),
      { kind: "automation-time", triggerId: trigger.id },
    );
    signal.throwIfAborted();

    const result = await set(
      createZeroRun$,
      {
        auth: {
          orgId: automation.orgId,
          orgRole: "member",
          userId: automation.userId,
          tokenType: "session",
        },
        body: {
          prompt: runInput.prompt,
          agentId: runInput.agentId,
          ...(effectiveModelProvider
            ? { modelProvider: effectiveModelProvider }
            : {}),
        },
        apiStartTime: args.apiStartTime,
        triggerSource: "schedule",
        chatThreadId: runInput.chatThreadId,
        modelProviderId: modelPin.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          modelPin.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: modelPin.selectedModel ?? undefined,
        appendSystemPrompt: runInput.appendSystemPrompt,
        callbacks: runInput.callbacks,
        zeroRunMetadata: runInput.zeroRunMetadata,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== 201) {
      return { kind: "run_error", response: result };
    }

    await postAutomationUserMessage({
      db,
      threadId: automation.chatThreadId,
      userId: automation.userId,
      runId: result.body.runId,
      prompt: runInput.prompt,
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
      .update(automationTriggers)
      .set({ lastRunId: result.body.runId })
      .where(eq(automationTriggers.id, trigger.id));
    signal.throwIfAborted();

    return { kind: "ok", runId: result.body.runId };
  },
);

/**
 * Dormant time poller over `automation_triggers` — the events-first counterpart
 * of `executeDueSchedules$`, built for the (later, gated) cutover and NOT wired
 * to any live cron route in this slice. It mirrors the schedule poller's
 * semantics 1:1: scan enabled time triggers whose `next_run_at` is due, skip any
 * whose previous run is still active, optimistic-lock claim the due row (clears
 * `next_run_at`; disables once-triggers), then create the run via the default
 * interpreter (tagged with automation + trigger provenance, carrying the
 * trigger completion callback that advances the recurrence) and auto-disable a
 * trigger after consecutive pre-run failures. Nothing here changes live
 * execution; `executeDueSchedules$` remains the only schedule executor.
 */
export const executeDueTriggers$ = command(
  async ({ set }, signal: AbortSignal): Promise<ExecuteDueTriggersResult> => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    log.debug("Checking for due triggers", {
      currentTime: currentTime.toISOString(),
    });

    const rows = await db
      .select({
        trigger: automationTriggers,
        automationId: automations.id,
        agentId: automations.agentId,
        orgId: automations.orgId,
        userId: automations.userId,
        chatThreadId: automations.chatThreadId,
        instruction: automations.instruction,
        automationEnabled: automations.enabled,
      })
      .from(automationTriggers)
      .innerJoin(
        automations,
        eq(automationTriggers.automationId, automations.id),
      )
      .where(
        and(
          eq(automationTriggers.enabled, true),
          inArray(automationTriggers.kind, [...TIME_TRIGGER_KINDS]),
          lte(automationTriggers.nextRunAt, currentTime),
        ),
      )
      .limit(10);
    signal.throwIfAborted();

    let executed = 0;
    let skipped = 0;
    const timeTrigger = new TimeTrigger();

    for (const row of rows) {
      // A disabled automation suspends all its triggers without touching their
      // own enabled flag (mirrors the webhook dispatch's automation gate).
      if (!row.automationEnabled) {
        log.debug("Skipping trigger: automation disabled", {
          triggerId: row.trigger.id,
          automationId: row.automationId,
        });
        skipped++;
        continue;
      }

      const due: DueTrigger = {
        trigger: row.trigger,
        automation: {
          id: row.automationId,
          agentId: row.agentId,
          orgId: row.orgId,
          userId: row.userId,
          chatThreadId: row.chatThreadId,
          instruction: row.instruction,
        },
      };

      if (row.trigger.lastRunId) {
        const [lastRun] = await db
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, row.trigger.lastRunId))
          .limit(1);
        signal.throwIfAborted();

        if (lastRun && isActivePreviousRunStatus(lastRun.status)) {
          log.debug("Skipping trigger: previous run still active", {
            triggerId: row.trigger.id,
            automationId: row.automationId,
          });
          skipped++;
          continue;
        }
      }

      const claimed = await timeTrigger.evaluateTrigger({
        db,
        trigger: row.trigger,
        currentTime,
      });
      signal.throwIfAborted();

      if (!claimed) {
        log.debug("Skipping trigger: already claimed", {
          triggerId: row.trigger.id,
          automationId: row.automationId,
        });
        skipped++;
        continue;
      }

      const runResult = await settle(
        set(runTriggerNow$, { due, apiStartTime: now() }, signal),
      );
      signal.throwIfAborted();
      if (!runResult.ok) {
        await recordTriggerPreRunFailure(db, due, runResult.error, signal);
        skipped++;
        continue;
      }
      const result = runResult.value;
      if (result.kind !== "ok") {
        await recordTriggerPreRunFailure(db, due, result, signal);
        skipped++;
        continue;
      }
      executed++;
    }

    log.debug("Executed due triggers", { executed, skipped });
    return { executed, skipped };
  },
);
