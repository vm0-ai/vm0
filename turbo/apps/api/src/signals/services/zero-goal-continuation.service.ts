import { randomBytes } from "node:crypto";

import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { command } from "ccstate";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { now } from "../external/time";
import type { DispatchFailedRunCallbacks } from "./agent-run-create.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import {
  postAutomationUserMessage,
  resolveAutomationChatThreadModelPin,
} from "./zero-chat-automation-message.service";
import {
  pauseActiveGoalForThread,
  loadActiveGoalForThread,
  type GoalBootstrap,
} from "./zero-goal.service";
import {
  resolveModelFirstProviderAdmission,
  type ModelFirstPin,
} from "./zero-model-selection.service";
import { createZeroRun$ } from "./zero-runs-create.service";

const log = logger("api:zero-goal-continuation");

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
  | { readonly kind: "paused"; readonly goalId: string }
  | {
      readonly kind: "failed-to-enqueue";
      readonly goalId: string;
      readonly error: string;
    };

export type RunGoalResult =
  | { readonly kind: "ok"; readonly runId: string }
  | { readonly kind: "conflict"; readonly message: string }
  | {
      readonly kind: "run_error";
      readonly response: {
        readonly status: number;
        readonly body: {
          readonly error: { readonly message: string; readonly code: string };
        };
      };
    };

interface InternalRunCallbackInput {
  readonly internalKind: InternalRunCallbackKind;
  readonly secret: string;
  readonly payload: unknown;
}

type ModelContext =
  | {
      readonly ok: true;
      readonly modelPin: ModelFirstPin;
      readonly effectiveModelProvider: string | null | undefined;
    }
  | {
      readonly ok: false;
      readonly failure: Exclude<RunGoalResult, { kind: "ok" }>;
    };

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
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

function failureMessage(error: RunGoalResult): string {
  if (error.kind === "conflict") {
    return error.message;
  }
  if (error.kind === "run_error") {
    return `${error.response.status} ${error.response.body.error.code}: ${error.response.body.error.message}`;
  }
  return `Unexpected successful run result: ${error.runId}`;
}

function buildGoalContinuationSystemPrompt(goal: {
  readonly objective: string;
  readonly objectiveBrief: string;
}): string {
  const lines = [
    "# Current context",
    "You are autonomously continuing a persistent goal on this web chat thread.",
    "Everything you output is shown to the user in this thread.",
    "",
    "# Active thread goal",
    "",
    goal.objective,
  ];
  if (goal.objectiveBrief !== goal.objective) {
    lines.push("", "# User-visible objective brief", "", goal.objectiveBrief);
  }
  lines.push(
    "",
    "# How to operate",
    "",
    "- Make concrete progress this turn, then end the turn. The goal automatically continues on the next idle.",
    "- Persist all progress to durable external state (commits, PRs, uploaded artifacts, connectors).",
    "- When the objective is verifiably done, audit it requirement-by-requirement against the current external state; only then run `zero goal complete`.",
    "- If the same blocker stops you for 3 consecutive turns, run `zero goal block` and explain why.",
    "- Inspect goal state anytime with `zero goal get`.",
    "- Do not create, edit, pause, resume, or clear goals from an autonomous goal continuation run.",
    "- Do not stop to ask the user and wait; act on the best available information.",
  );
  return lines.join("\n");
}

function buildGoalContinuationPrompt(goal: {
  readonly objectiveBrief: string;
}): string {
  return goal.objectiveBrief;
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

function buildGoalChatCallbacks(args: {
  readonly threadId: string;
  readonly agentId: string;
}): readonly InternalRunCallbackInput[] {
  return [
    {
      internalKind: "chat",
      secret: generateCallbackSecret(),
      payload: {
        threadId: args.threadId,
        agentId: args.agentId,
        isGoalRun: true,
      },
    },
  ];
}

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

export const runGoalNow$ = command(
  async (
    { set },
    args: {
      readonly goal: GoalBootstrap;
      readonly sessionId?: string;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
    signal: AbortSignal,
  ): Promise<RunGoalResult> => {
    const db = set(writeDb$);
    const goal = args.goal;

    const modelContext = await resolveModelContext({
      db,
      orgId: goal.orgId,
      userId: goal.userId,
      chatThreadId: goal.threadId,
      signal,
    });
    if (!modelContext.ok) {
      return modelContext.failure;
    }
    const { modelPin, effectiveModelProvider } = modelContext;

    const prompt = buildGoalContinuationPrompt(goal);
    const result = await set(
      createZeroRun$,
      {
        auth: {
          orgId: goal.orgId,
          orgRole: "member",
          userId: goal.userId,
          tokenType: "session",
        },
        body: {
          prompt,
          agentId: goal.agentId,
          ...(args.sessionId ? { sessionId: args.sessionId } : {}),
          ...(effectiveModelProvider
            ? { modelProvider: effectiveModelProvider }
            : {}),
        },
        apiStartTime: now(),
        triggerSource: "workflow-event",
        chatThreadId: goal.threadId,
        modelProviderId: modelPin.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          modelPin.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: modelPin.selectedModel ?? undefined,
        appendSystemPrompt: buildGoalContinuationSystemPrompt(goal),
        callbacks: buildGoalChatCallbacks({
          threadId: goal.threadId,
          agentId: goal.agentId,
        }),
        zeroRunMetadata: { goalId: goal.goalId, runGroupId: goal.goalId },
        dispatchFailedCallbacks: args.dispatchFailedCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== 201) {
      return { kind: "run_error", response: result };
    }

    await postAutomationUserMessage({
      db,
      threadId: goal.threadId,
      userId: goal.userId,
      runId: result.body.runId,
      prompt,
      appendQueueMarker: result.body.status === "queued",
      runGroupId: goal.goalId,
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

    return { kind: "ok", runId: result.body.runId };
  },
);

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

    const goal = await loadActiveGoalForThread(db, {
      orgId: run.orgId,
      threadId: run.chatThreadId,
    });
    signal.throwIfAborted();
    if (!goal) {
      return { kind: "skipped", reason: "no-active-goal" };
    }

    if (
      run.status === "cancelled" ||
      run.status === "failed" ||
      run.status === "timeout"
    ) {
      const paused = await pauseActiveGoalForThread(db, {
        orgId: run.orgId,
        userId: run.userId,
        threadId: run.chatThreadId,
      });
      signal.throwIfAborted();
      if (paused.kind !== "ok") {
        return { kind: "skipped", reason: `pause-${paused.kind}` };
      }
      return { kind: "paused", goalId: goal.id };
    }

    if (!(await threadIsIdle(db, run.chatThreadId))) {
      return { kind: "skipped", reason: "thread-not-idle" };
    }
    signal.throwIfAborted();

    const sessionId = await latestSessionIdForThread(db, run.chatThreadId);
    signal.throwIfAborted();
    const runResult = await set(
      runGoalNow$,
      {
        goal: {
          goalId: goal.id,
          orgId: goal.orgId,
          userId: goal.ownerUserId,
          threadId: goal.chatThreadId,
          agentId: goal.agentId,
          objective: goal.objective,
          objectiveBrief: goal.objectiveBrief,
        },
        ...(sessionId ? { sessionId } : {}),
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

    const paused = await pauseActiveGoalForThread(db, {
      orgId: run.orgId,
      userId: run.userId,
      threadId: run.chatThreadId,
    });
    signal.throwIfAborted();
    const error = failureMessage(runResult);
    log.warn("Goal continuation enqueue failed; goal paused", {
      goalId: goal.id,
      runId: run.runId,
      error,
      pauseResult: paused.kind,
    });
    return {
      kind: "failed-to-enqueue",
      goalId: goal.id,
      error,
    };
  },
);

export const bootstrapGoalRun$ = command(
  async (
    { set },
    args: {
      readonly goal: GoalBootstrap;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
    signal: AbortSignal,
  ): Promise<RunGoalResult> => {
    return await set(
      runGoalNow$,
      {
        goal: args.goal,
        dispatchFailedCallbacks: args.dispatchFailedCallbacks,
      },
      signal,
    );
  },
);
