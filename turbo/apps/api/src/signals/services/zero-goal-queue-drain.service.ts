import { command } from "ccstate";

import { logger } from "../../lib/log";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { writeDb$, type Db } from "../external/db";
import { now } from "../../lib/time";
import {
  isQueueFirstRunClaimLost,
  type DispatchFailedRunCallbacks,
} from "./agent-run-create.service";
import {
  ApiDispatchTimingCollector,
  type ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";
import {
  loadGoalQueueTarget,
  loadNextGoalQueueEvent,
  revokeGoalQueueEvent,
  settleFailedGoalQueueEvent,
  type GoalQueueTarget,
  type PendingGoalQueueEvent,
} from "./chat-goal-queue.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import { resolveRunChatThreadModelContext } from "./zero-chat-run-event.service";
import { normalizeGoalObjectiveBrief } from "./zero-goal-objective-brief-normalization.service";
import type { ModelFirstPin } from "./zero-model-selection.service";
import { createQueueFirstZeroRun$ } from "./zero-runs-create.service";

const log = logger("api:zero-goal-queue-drain");
const MAX_DRAIN_ATTEMPTS = 5;
const GOAL_CONTINUATION_PROMPT = "Continue the active thread goal.";

type GoalDrainAttempt = "initial" | "retry";
type GoalDrainTimingRole = "waiting" | "phase" | "aggregate";
type QueueFirstZeroRunInput = Parameters<
  (typeof createQueueFirstZeroRun$)["write"]
>[1];

function goalDrainAttempt(attempt: number): GoalDrainAttempt {
  return attempt === 0 ? "initial" : "retry";
}

function goalDrainTimingDimensions(args: {
  readonly attempt?: GoalDrainAttempt;
  readonly role: GoalDrainTimingRole;
}): ApiDispatchTimingDimensions {
  return {
    ...(args.attempt ? { goal_drain_attempt: args.attempt } : {}),
    goal_drain_timing_role: args.role,
  };
}

interface InternalRunCallbackInput {
  readonly internalKind: InternalRunCallbackKind;
  readonly payload: unknown;
}

type RunGoalResult =
  | { readonly kind: "ok"; readonly runId: string }
  | { readonly kind: "enqueued" }
  | {
      readonly kind: "run_error";
      readonly response: {
        readonly status: number;
        readonly body: {
          readonly error: { readonly message: string; readonly code: string };
        };
      };
    };

type ModelContext =
  | {
      readonly ok: true;
      readonly modelPin: ModelFirstPin;
      readonly effectiveModelProvider: string | null | undefined;
      readonly cliAgentType: string | null;
      readonly codexServiceTier: "fast" | undefined;
    }
  | {
      readonly ok: false;
      readonly failure: Extract<RunGoalResult, { readonly kind: "run_error" }>;
    };

function buildGoalAppendSystemPrompt(goal: {
  readonly objective: string;
  readonly objectiveBrief: string;
  readonly autonomyBudget: number;
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
  lines.push("", `Autonomy budget: ${goal.autonomyBudget}`);
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

function buildGoalChatCallbacks(args: {
  readonly threadId: string;
  readonly agentId: string;
}): readonly InternalRunCallbackInput[] {
  return [
    {
      internalKind: "chat",
      payload: {
        threadId: args.threadId,
        agentId: args.agentId,
      },
    },
  ];
}

function buildQueueFirstGoalRunInput(args: {
  readonly event: PendingGoalQueueEvent;
  readonly goal: GoalQueueTarget;
  readonly modelContext: Extract<ModelContext, { readonly ok: true }>;
  readonly apiStartTime: number;
  readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
  readonly timing: ApiDispatchTimingCollector;
}): QueueFirstZeroRunInput {
  const normalizedGoal = {
    ...args.goal,
    objectiveBrief: normalizeGoalObjectiveBrief({
      objective: args.goal.objective,
      objectiveBrief: args.goal.objectiveBrief,
    }),
  };
  const prompt = GOAL_CONTINUATION_PROMPT;
  const appendSystemPrompt = buildGoalAppendSystemPrompt(normalizedGoal);
  const { modelPin, effectiveModelProvider, cliAgentType, codexServiceTier } =
    args.modelContext;
  return {
    auth: {
      orgId: normalizedGoal.orgId,
      orgRole: "member",
      userId: normalizedGoal.userId,
      tokenType: "session",
    },
    body: {
      prompt,
      agentId: normalizedGoal.agentId,
      ...(effectiveModelProvider
        ? { modelProvider: effectiveModelProvider }
        : {}),
    },
    apiStartTime: args.apiStartTime,
    triggerSource: "workflow-event",
    appendSystemPrompt,
    chatThreadId: normalizedGoal.threadId,
    modelProviderId: modelPin.modelProviderId ?? undefined,
    modelProviderCredentialScope:
      modelPin.modelProviderCredentialScope ?? undefined,
    selectedModelOverride: modelPin.selectedModel ?? undefined,
    threadSessionRoute: {
      selectedModel: modelPin.selectedModel,
      modelProvider: effectiveModelProvider ?? null,
      modelProviderId: modelPin.modelProviderId,
      cliAgentType,
    },
    codexServiceTier,
    callbacks: buildGoalChatCallbacks({
      threadId: normalizedGoal.threadId,
      agentId: normalizedGoal.agentId,
    }),
    zeroRunMetadata: {
      goalId: normalizedGoal.goalId,
      autonomyBudget: normalizedGoal.autonomyBudget,
    },
    queueFirstAssociation: {
      kind: "goal_input",
      threadId: normalizedGoal.threadId,
      eventId: args.event.id,
      prompt,
      goalId: normalizedGoal.goalId,
      goalObjectiveBrief: normalizedGoal.objectiveBrief,
      goalStateRevision: normalizedGoal.stateRevision,
      orgId: normalizedGoal.orgId,
      userId: normalizedGoal.userId,
    },
    zeroRunModelPin: {
      modelProvider: effectiveModelProvider ?? null,
      modelProviderId: modelPin.modelProviderId,
      modelProviderCredentialScope: modelPin.modelProviderCredentialScope,
      selectedModel: modelPin.selectedModel,
    },
    dispatchFailedCallbacks: args.dispatchFailedCallbacks,
    timing: args.timing,
  };
}

async function resolveModelContext(
  args: {
    readonly db: Db;
    readonly goal: GoalQueueTarget;
  },
  signal: AbortSignal,
): Promise<ModelContext> {
  const threadModelContext = await resolveRunChatThreadModelContext({
    db: args.db,
    orgId: args.goal.orgId,
    userId: args.goal.userId,
    threadId: args.goal.threadId,
  });
  signal.throwIfAborted();
  if ("status" in threadModelContext) {
    return {
      ok: false,
      failure: {
        kind: "run_error",
        response: {
          status: threadModelContext.status,
          body: threadModelContext.body,
        },
      },
    };
  }

  const { pin, providerAdmission, runCodexServiceTier } = threadModelContext;
  signal.throwIfAborted();
  if (providerAdmission.error) {
    return {
      ok: false,
      failure: { kind: "run_error", response: providerAdmission.error },
    };
  }

  return {
    ok: true,
    modelPin: pin,
    effectiveModelProvider: providerAdmission.effectiveModelProvider,
    cliAgentType: providerAdmission.cliAgentType,
    codexServiceTier: runCodexServiceTier,
  };
}

async function publishGoalQueueChanged(
  event: PendingGoalQueueEvent,
  signal: AbortSignal,
): Promise<void> {
  await publishChatThreadMessageCreatedSafely(event.userId, event.chatThreadId);
  signal.throwIfAborted();
}

async function revokeGoalEvent(
  db: Db,
  event: PendingGoalQueueEvent,
  signal: AbortSignal,
): Promise<boolean> {
  const revoked = await revokeGoalQueueEvent(db, {
    chatThreadId: event.chatThreadId,
    eventId: event.id,
  });
  signal.throwIfAborted();
  if (revoked) {
    await publishGoalQueueChanged(event, signal);
  }
  return revoked;
}

const launchQueuedGoal$ = command(
  async (
    { set },
    args: {
      readonly event: PendingGoalQueueEvent;
      readonly goal: GoalQueueTarget;
      readonly apiStartTime: number;
      readonly attempt: GoalDrainAttempt;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
      readonly timing: ApiDispatchTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<RunGoalResult> => {
    const db = set(writeDb$);
    const phaseDimensions = goalDrainTimingDimensions({
      attempt: args.attempt,
      role: "phase",
    });
    const modelContext = await args.timing.measure(
      "api_dispatch_pre_create_zero_goal_drain_resolve_model_context",
      "nested",
      async () => {
        return await resolveModelContext(
          {
            db,
            goal: args.goal,
          },
          signal,
        );
      },
      phaseDimensions,
    );
    signal.throwIfAborted();
    if (!modelContext.ok) {
      return modelContext.failure;
    }
    const runInput = args.timing.measureSync<QueueFirstZeroRunInput>(
      "api_dispatch_pre_create_zero_goal_drain_build_run_input",
      "nested",
      () => {
        return buildQueueFirstGoalRunInput({
          event: args.event,
          goal: args.goal,
          modelContext,
          apiStartTime: args.apiStartTime,
          dispatchFailedCallbacks: args.dispatchFailedCallbacks,
          timing: args.timing,
        });
      },
      phaseDimensions,
    );
    const handoffAt = now();
    args.timing.recordElapsed(
      "api_dispatch_pre_create_zero_entrypoint_gap",
      "nested",
      args.apiStartTime,
      handoffAt,
      goalDrainTimingDimensions({
        attempt: args.attempt,
        role: "aggregate",
      }),
    );
    args.timing.recordElapsed(
      "api_dispatch_pre_create_zero_goal_drain_handoff_run",
      "nested",
      handoffAt,
      handoffAt,
      phaseDimensions,
    );
    const result = await set(createQueueFirstZeroRun$, runInput, signal);
    signal.throwIfAborted();

    if (isQueueFirstRunClaimLost(result)) {
      return { kind: "enqueued" };
    }
    if (result.status !== 201) {
      return { kind: "run_error", response: result };
    }
    return { kind: "ok", runId: result.body.runId };
  },
);

export const drainGoalQueueForThread$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly apiStartTime?: number;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
      readonly queueItemCreatedBefore?: Date;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const drainStartedAt = now();
    const apiStartTime = args.apiStartTime ?? drainStartedAt;
    const timing = new ApiDispatchTimingCollector();
    timing.recordElapsed(
      "api_dispatch_pre_create_zero_goal_drain_scheduler_start_gap",
      "nested",
      apiStartTime,
      drainStartedAt,
      goalDrainTimingDimensions({ role: "waiting" }),
    );
    const db = set(writeDb$);

    for (let attempt = 0; attempt < MAX_DRAIN_ATTEMPTS; attempt++) {
      const attemptCategory = goalDrainAttempt(attempt);
      const phaseDimensions = goalDrainTimingDimensions({
        attempt: attemptCategory,
        role: "phase",
      });
      const event = await timing.measure(
        "api_dispatch_pre_create_zero_goal_drain_load_event",
        "nested",
        async () => {
          return await loadNextGoalQueueEvent(
            db,
            args.chatThreadId,
            args.queueItemCreatedBefore,
          );
        },
        phaseDimensions,
      );
      signal.throwIfAborted();
      if (!event) {
        return;
      }
      timing.recordElapsed(
        "api_dispatch_pre_create_zero_goal_drain_event_queue_age",
        "nested",
        event.createdAt.getTime(),
        drainStartedAt,
        goalDrainTimingDimensions({
          attempt: attemptCategory,
          role: "waiting",
        }),
      );

      const goal = await timing.measure(
        "api_dispatch_pre_create_zero_goal_drain_load_target",
        "nested",
        async () => {
          return await loadGoalQueueTarget(db, event);
        },
        phaseDimensions,
      );
      signal.throwIfAborted();
      if (!goal) {
        await timing.measure(
          "api_dispatch_pre_create_zero_goal_drain_revoke_invalid_event",
          "nested",
          async () => {
            return await revokeGoalEvent(db, event, signal);
          },
          phaseDimensions,
        );
        signal.throwIfAborted();
        continue;
      }

      const result = await set(
        launchQueuedGoal$,
        {
          event,
          goal,
          apiStartTime,
          attempt: attemptCategory,
          dispatchFailedCallbacks: args.dispatchFailedCallbacks,
          timing,
        },
        signal,
      );
      signal.throwIfAborted();
      if (result.kind === "ok") {
        await publishGoalQueueChanged(event, signal);
        return;
      }

      if (result.kind === "enqueued") {
        const stillValid = await loadGoalQueueTarget(db, event);
        signal.throwIfAborted();
        if (!stillValid) {
          await revokeGoalEvent(db, event, signal);
          return;
        }
        if (stillValid.stateRevision !== goal.stateRevision) {
          continue;
        }
        return;
      }

      const settlement = await settleFailedGoalQueueEvent(db, {
        event,
        expectedGoalStateRevision: goal.stateRevision,
        reason: result.response.body.error.message,
      });
      signal.throwIfAborted();
      if (settlement.kind === "stale") {
        continue;
      }
      if (settlement.kind !== "not_pending") {
        await publishGoalQueueChanged(event, signal);
      }
      log.warn("Goal queue event failed to create a run", {
        eventId: event.id,
        goalId:
          settlement.kind === "rejected" ? settlement.goalId : event.goalId,
        code: result.response.body.error.code,
        rejected: settlement.kind === "rejected",
        pauseResult: settlement.kind === "rejected" ? "ok" : "not_paused",
        settlement: settlement.kind,
      });
      return;
    }
  },
);
