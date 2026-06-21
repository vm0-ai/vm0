import {
  zeroGoalPreferenceSchema,
  type ZeroGoalPreference,
  type ZeroGoalStopReason,
} from "@vm0/api-contracts/contracts/zero-goals";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import type { DispatchFailedRunCallbacks } from "./agent-run-create.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { sendUserPushNotifications } from "./zero-push-notifications.service";
import {
  buildChatOnlyWorkflowTriggerCallbacks,
  runWorkflowTriggerNow$,
  type RunFailure,
  type RunWorkflowTriggerResult,
  type TriggerRow,
} from "./zero-workflow-trigger-run.service";

const log = logger("api:zero-goal-continuation");

const MAX_CONSECUTIVE_FAILURES = 3;
const ACTIVE_RUN_STATUSES = ["queued", "pending", "running"] as const;

type TerminalRunStatus = "completed" | "failed" | "timeout" | "cancelled";

interface TerminatingRunContext {
  readonly runId: string;
  readonly status: string;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string | null;
}

type GoalContinuationResult =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "continued"; readonly runId: string }
  | { readonly kind: "paused"; readonly triggerId: string }
  | {
      readonly kind: "auto-stopped";
      readonly triggerId: string;
      readonly consecutiveFailures: number;
    }
  | {
      readonly kind: "failed-to-enqueue";
      readonly triggerId: string;
      readonly consecutiveFailures: number;
      readonly error: string;
    };

interface FailureUpdateResult {
  readonly disabled: boolean;
  readonly consecutiveFailures: number;
}

function isTerminalStatus(status: string): status is TerminalRunStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function agentSessionIdFromResult(result: unknown): string | null {
  if (!isRecord(result)) {
    return null;
  }
  const agentSessionId = result.agentSessionId;
  return typeof agentSessionId === "string" ? agentSessionId : null;
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

function buildGoalContinuationSystemPrompt(): string {
  return [
    "# Current context",
    "You are autonomously continuing a persistent goal on this web chat thread.",
    "Everything you output is shown to the user in this thread.",
  ].join("\n");
}

/**
 * The continuation user prompt — vm0's analog of Codex's `continuation.md`.
 * Rendered in code each turn with the goal's objective (and optional token
 * budget) from `zero_workflows.preference`, then injected as the run's user
 * prompt. Plain instruction text, not a `/goal` slash command, so the harness
 * never intercepts it.
 */
function buildGoalContinuationPrompt(preference: ZeroGoalPreference): string {
  const lines = [
    "# Active thread goal",
    "",
    "You are autonomously continuing a persistent goal. Make concrete progress this turn, then end the turn — the goal automatically continues on the next idle.",
    "",
    "## Objective",
    "",
    preference.objective,
    "",
  ];
  if (preference.tokenBudget) {
    lines.push(
      "## Token budget",
      "",
      `Soft budget: about ${preference.tokenBudget} tokens across the whole goal. Be economical; if you have clearly exhausted it without completing, run \`zero goal block\` and explain.`,
      "",
    );
  }
  lines.push(
    "## How to operate",
    "",
    "- Persist all progress to durable external state (commits, PRs, uploaded artifacts, connectors). The sandbox filesystem is fresh every turn; only the conversation session carries over.",
    "- When the objective is verifiably done, audit it requirement-by-requirement against the current external state (not your assumptions); only then run `zero goal complete`.",
    "- If the same blocker stops you for 3 consecutive turns, run `zero goal block` and explain why.",
    "- Inspect goal state anytime with `zero goal get`.",
    "- Do not stop to ask the user and wait — this is an autonomous continuation; act on the best available information.",
  );
  return lines.join("\n");
}

async function loadTerminatingRun(
  db: Db,
  runId: string,
): Promise<TerminatingRunContext | null> {
  const [row] = await db
    .select({
      runId: agentRuns.id,
      status: agentRuns.status,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      chatThreadId: zeroRuns.chatThreadId,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);

  return row ?? null;
}

interface EnabledGoal {
  readonly trigger: TriggerRow;
  // Derived from the workflow row under hard 1:N; the trigger no longer carries
  // an agentId column.
  readonly agentId: string;
  readonly preference: ZeroGoalPreference;
}

async function loadEnabledGoalTrigger(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
  },
): Promise<EnabledGoal | null> {
  const [row] = await db
    .select({
      trigger: zeroWorkflowTriggers,
      agentId: zeroWorkflows.agentId,
      preference: zeroWorkflows.preference,
    })
    .from(zeroWorkflowTriggers)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflowTriggers.workflowId, zeroWorkflows.id),
    )
    .where(
      and(
        eq(zeroWorkflowTriggers.orgId, args.orgId),
        eq(zeroWorkflowTriggers.ownerUserId, args.userId),
        eq(zeroWorkflowTriggers.chatThreadId, args.chatThreadId),
        eq(zeroWorkflowTriggers.kind, "event"),
        eq(zeroWorkflowTriggers.eventType, "thread-idle"),
        eq(zeroWorkflowTriggers.enabled, true),
        isNotNull(zeroWorkflowTriggers.chatThreadId),
        eq(zeroWorkflows.type, "goal"),
        eq(zeroWorkflows.active, true),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }
  return {
    trigger: row.trigger,
    agentId: row.agentId,
    preference: zeroGoalPreferenceSchema.parse(row.preference),
  };
}

async function loadGoalPreference(
  db: Db,
  workflowId: string,
): Promise<{
  readonly agentId: string;
  readonly preference: ZeroGoalPreference;
} | null> {
  const [row] = await db
    .select({
      agentId: zeroWorkflows.agentId,
      preference: zeroWorkflows.preference,
    })
    .from(zeroWorkflows)
    .where(
      and(eq(zeroWorkflows.id, workflowId), eq(zeroWorkflows.type, "goal")),
    )
    .limit(1);

  if (!row) {
    return null;
  }
  return {
    agentId: row.agentId,
    preference: zeroGoalPreferenceSchema.parse(row.preference),
  };
}

async function featureEnabledForRun(
  db: Db,
  run: TerminatingRunContext,
): Promise<boolean> {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    run.orgId,
    run.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.GoalWorkflows, featureSwitchContext);
}

async function threadIsIdle(db: Db, chatThreadId: string): Promise<boolean> {
  const [activeRun] = await db
    .select({ id: zeroRuns.id })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(
        eq(zeroRuns.chatThreadId, chatThreadId),
        inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
      ),
    )
    .limit(1);

  return activeRun === undefined;
}

async function latestSessionIdForThread(
  db: Db,
  chatThreadId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ result: agentRuns.result })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(eq(zeroRuns.chatThreadId, chatThreadId), isNotNull(agentRuns.result)),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(10);

  for (const row of rows) {
    const sessionId = agentSessionIdFromResult(row.result);
    if (sessionId) {
      return sessionId;
    }
  }
  return undefined;
}

/**
 * Notify the user that a goal stopped on its own after repeated failures.
 *
 * Goal-triggered runs suppress their per-iteration push in the chat callback;
 * the only failure worth surfacing is the terminal auto-stop, which is decided
 * here (after the chat callback), so this is where that push is sent.
 */
async function notifyGoalAutoStopped(
  db: Db,
  args: {
    readonly userId: string;
    readonly chatThreadId: string;
    readonly objective: string;
  },
): Promise<void> {
  await sendUserPushNotifications({
    db,
    userId: args.userId,
    notification: {
      title: args.objective.slice(0, 60),
      body: "Goal stopped automatically after repeated failures",
      url: `/chats/${args.chatThreadId}`,
    },
  });
}

// Disables a goal trigger after a user cancel, recording the "paused" stop
// reason so the goal surfaces as paused rather than agent-blocked.
async function disableGoalTrigger(
  db: Db,
  trigger: { readonly id: string; readonly workflowId: string },
): Promise<void> {
  const currentTime = nowDate();
  await db
    .update(zeroWorkflowTriggers)
    .set({ enabled: false, nextRunAt: null, updatedAt: currentTime })
    .where(eq(zeroWorkflowTriggers.id, trigger.id));
  await setGoalStopReason(db, trigger.workflowId, "paused");
}

/**
 * Record why a goal stopped in the workflow's preference jsonb. The status enum
 * stays "blocked"; stopReason is an additional field that distinguishes a manual
 * cancel ("paused") from a repeated-failure auto-stop ("failed").
 */
async function setGoalStopReason(
  db: Db,
  workflowId: string,
  stopReason: ZeroGoalStopReason,
): Promise<void> {
  const goal = await loadGoalPreference(db, workflowId);
  if (!goal) {
    return;
  }
  await db
    .update(zeroWorkflows)
    .set({
      preference: { ...goal.preference, stopReason },
      updatedAt: nowDate(),
    })
    .where(eq(zeroWorkflows.id, workflowId));
}

async function resetGoalTriggerFailures(
  db: Db,
  triggerId: string,
): Promise<void> {
  await db
    .update(zeroWorkflowTriggers)
    .set({ consecutiveFailures: 0, updatedAt: nowDate() })
    .where(eq(zeroWorkflowTriggers.id, triggerId));
}

// Increments the failure counter and, once the threshold disables the trigger,
// records the "failed" stop reason so the goal surfaces the auto-stop cause.
async function incrementGoalTriggerFailures(
  db: Db,
  trigger: { readonly id: string; readonly workflowId: string },
): Promise<FailureUpdateResult> {
  const currentTime = nowDate();
  const [updated] = await db
    .update(zeroWorkflowTriggers)
    .set({
      consecutiveFailures: sql<number>`${zeroWorkflowTriggers.consecutiveFailures} + 1`,
      enabled: sql<boolean>`(${zeroWorkflowTriggers.consecutiveFailures} + 1) < ${MAX_CONSECUTIVE_FAILURES}`,
      nextRunAt: null,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(zeroWorkflowTriggers.id, trigger.id),
        eq(zeroWorkflowTriggers.enabled, true),
      ),
    )
    .returning({
      consecutiveFailures: zeroWorkflowTriggers.consecutiveFailures,
      enabled: zeroWorkflowTriggers.enabled,
    });

  const result: FailureUpdateResult = updated
    ? {
        disabled: !updated.enabled,
        consecutiveFailures: updated.consecutiveFailures,
      }
    : { disabled: true, consecutiveFailures: MAX_CONSECUTIVE_FAILURES };
  if (result.disabled) {
    await setGoalStopReason(db, trigger.workflowId, "failed");
  }
  return result;
}

/**
 * Notify the user and produce the `auto-stopped` continuation result, shared by
 * the run-failure and enqueue-failure paths.
 */
async function autoStopGoalAndNotify(
  db: Db,
  args: {
    readonly userId: string;
    readonly chatThreadId: string;
    readonly objective: string;
    readonly triggerId: string;
    readonly consecutiveFailures: number;
  },
): Promise<GoalContinuationResult> {
  await notifyGoalAutoStopped(db, {
    userId: args.userId,
    chatThreadId: args.chatThreadId,
    objective: args.objective,
  });
  return {
    kind: "auto-stopped",
    triggerId: args.triggerId,
    consecutiveFailures: args.consecutiveFailures,
  };
}

export const continueGoalIfIdle$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly runId: string;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
    signal: AbortSignal,
  ): Promise<GoalContinuationResult> => {
    const db = args.db;
    const run = await loadTerminatingRun(db, args.runId);
    signal.throwIfAborted();
    if (!run?.chatThreadId) {
      return { kind: "skipped", reason: "run-not-linked-to-chat-thread" };
    }
    if (!isTerminalStatus(run.status)) {
      return { kind: "skipped", reason: "run-not-terminal" };
    }
    if (!(await featureEnabledForRun(db, run))) {
      return { kind: "skipped", reason: "feature-disabled" };
    }
    signal.throwIfAborted();

    const goal = await loadEnabledGoalTrigger(db, {
      orgId: run.orgId,
      userId: run.userId,
      chatThreadId: run.chatThreadId,
    });
    signal.throwIfAborted();
    if (!goal) {
      return { kind: "skipped", reason: "no-enabled-active-goal" };
    }
    const trigger = goal.trigger;

    if (run.status === "cancelled") {
      await disableGoalTrigger(db, trigger);
      signal.throwIfAborted();
      return { kind: "paused", triggerId: trigger.id };
    }

    if (run.status === "failed" || run.status === "timeout") {
      const failureUpdate = await incrementGoalTriggerFailures(db, trigger);
      signal.throwIfAborted();
      if (failureUpdate.disabled) {
        log.warn("Goal continuation auto-stopped after run failures", {
          triggerId: trigger.id,
          runId: run.runId,
          consecutiveFailures: failureUpdate.consecutiveFailures,
        });
        signal.throwIfAborted();
        return autoStopGoalAndNotify(db, {
          userId: run.userId,
          chatThreadId: run.chatThreadId,
          objective: goal.preference.objective,
          triggerId: trigger.id,
          consecutiveFailures: failureUpdate.consecutiveFailures,
        });
      }
    } else {
      await resetGoalTriggerFailures(db, trigger.id);
      signal.throwIfAborted();
    }

    if (!(await threadIsIdle(db, run.chatThreadId))) {
      return { kind: "skipped", reason: "thread-not-idle" };
    }
    signal.throwIfAborted();

    const sessionId = await latestSessionIdForThread(db, run.chatThreadId);
    signal.throwIfAborted();
    const runResult = await set(
      runWorkflowTriggerNow$,
      {
        due: { trigger, agentId: goal.agentId, workflowName: "goal" },
        apiStartTime: now(),
        ...(sessionId ? { sessionId } : {}),
        prompt: buildGoalContinuationPrompt(goal.preference),
        triggerSource: "workflow-event",
        appendSystemPrompt: buildGoalContinuationSystemPrompt(),
        callbacks: buildChatOnlyWorkflowTriggerCallbacks(
          trigger,
          goal.agentId,
          {
            isGoalRun: true,
          },
        ),
        recordLastRunAt: true,
        dispatchFailedCallbacks: args.dispatchFailedCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();

    if (runResult.kind === "ok") {
      return { kind: "continued", runId: runResult.runId };
    }
    if (runResult.kind === "conflict") {
      return { kind: "skipped", reason: "previous-run-active" };
    }

    const failureUpdate = await incrementGoalTriggerFailures(db, trigger);
    signal.throwIfAborted();
    const error = failureMessage(runResult);
    if (failureUpdate.disabled) {
      log.warn("Goal continuation auto-stopped after enqueue failures", {
        triggerId: trigger.id,
        runId: run.runId,
        consecutiveFailures: failureUpdate.consecutiveFailures,
        error,
      });
      signal.throwIfAborted();
      return autoStopGoalAndNotify(db, {
        userId: run.userId,
        chatThreadId: run.chatThreadId,
        objective: goal.preference.objective,
        triggerId: trigger.id,
        consecutiveFailures: failureUpdate.consecutiveFailures,
      });
    }

    log.warn("Goal continuation enqueue failed", {
      triggerId: trigger.id,
      runId: run.runId,
      consecutiveFailures: failureUpdate.consecutiveFailures,
      error,
    });
    return {
      kind: "failed-to-enqueue",
      triggerId: trigger.id,
      consecutiveFailures: failureUpdate.consecutiveFailures,
      error,
    };
  },
);

/**
 * Kick off the very first run of a goal whose thread was just provisioned by
 * goal creation. A normal goal continues itself off the thread-idle event when
 * an in-flight run terminates, but a brand-new empty thread has no such run, so
 * the first turn must be enqueued explicitly. Subsequent turns continue through
 * `continueGoalIfIdle$` like any other goal.
 */
export const bootstrapGoalRun$ = command(
  async (
    { set },
    args: {
      readonly trigger: TriggerRow;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
    signal: AbortSignal,
  ): Promise<RunWorkflowTriggerResult> => {
    const db = set(writeDb$);
    const goal = await loadGoalPreference(db, args.trigger.workflowId);
    signal.throwIfAborted();
    if (!goal) {
      return {
        kind: "run_error",
        response: {
          status: 400,
          body: {
            error: {
              message: "Goal workflow not found for bootstrap",
              code: "INVALID_TRIGGER",
            },
          },
        },
      };
    }
    return set(
      runWorkflowTriggerNow$,
      {
        due: {
          trigger: args.trigger,
          agentId: goal.agentId,
          workflowName: "goal",
        },
        apiStartTime: now(),
        prompt: buildGoalContinuationPrompt(goal.preference),
        triggerSource: "workflow-event",
        appendSystemPrompt: buildGoalContinuationSystemPrompt(),
        callbacks: buildChatOnlyWorkflowTriggerCallbacks(
          args.trigger,
          goal.agentId,
          { isGoalRun: true },
        ),
        recordLastRunAt: true,
        dispatchFailedCallbacks: args.dispatchFailedCallbacks,
      },
      signal,
    );
  },
);
