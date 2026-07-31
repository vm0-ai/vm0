import { command } from "ccstate";

import { logger } from "../../lib/log";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { writeDb$, type Db } from "../external/db";
import { now } from "../external/time";
import {
  isQueueFirstRunClaimLost,
  type DispatchFailedRunCallbacks,
} from "./agent-run-create.service";
import {
  loadGoalQueueTarget,
  loadNextGoalQueueEvent,
  rejectGoalQueueEvent,
  type GoalQueueTarget,
  type PendingGoalQueueEvent,
} from "./chat-goal-queue.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import { resolveRunChatThreadModelContext } from "./zero-chat-run-event.service";
import { normalizeGoalObjectiveBrief } from "./zero-goal-objective-brief-normalization.service";
import { pauseActiveGoalForThread } from "./zero-goal.service";
import type { ModelFirstPin } from "./zero-model-selection.service";
import { createQueueFirstZeroRun$ } from "./zero-runs-create.service";

const log = logger("api:zero-goal-queue-drain");
const MAX_DRAIN_ATTEMPTS = 5;
const GOAL_INVALIDATED_REASON =
  "Goal continuation no longer matches the active goal";

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

function buildGoalContinuationPrompt(goal: {
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
        isGoalRun: true,
      },
    },
  ];
}

async function resolveModelContext(args: {
  readonly db: Db;
  readonly goal: GoalQueueTarget;
  readonly signal: AbortSignal;
}): Promise<ModelContext> {
  const threadModelContext = await resolveRunChatThreadModelContext({
    db: args.db,
    orgId: args.goal.orgId,
    userId: args.goal.userId,
    threadId: args.goal.threadId,
  });
  args.signal.throwIfAborted();
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
  args.signal.throwIfAborted();
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

async function rejectGoalEvent(
  db: Db,
  event: PendingGoalQueueEvent,
  reason: string,
  signal: AbortSignal,
): Promise<boolean> {
  const rejected = await rejectGoalQueueEvent(db, {
    chatThreadId: event.chatThreadId,
    eventId: event.id,
    orgId: event.orgId,
    userId: event.userId,
    reason,
  });
  signal.throwIfAborted();
  if (rejected) {
    await publishGoalQueueChanged(event, signal);
  }
  return rejected;
}

const launchQueuedGoal$ = command(
  async (
    { set },
    args: {
      readonly event: PendingGoalQueueEvent;
      readonly goal: GoalQueueTarget;
      readonly apiStartTime?: number;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
    signal: AbortSignal,
  ): Promise<RunGoalResult> => {
    const db = set(writeDb$);
    const modelContext = await resolveModelContext({
      db,
      goal: args.goal,
      signal,
    });
    if (!modelContext.ok) {
      return modelContext.failure;
    }
    const { modelPin, effectiveModelProvider, cliAgentType, codexServiceTier } =
      modelContext;

    const normalizedGoal = {
      ...args.goal,
      objectiveBrief: normalizeGoalObjectiveBrief({
        objective: args.goal.objective,
        objectiveBrief: args.goal.objectiveBrief,
      }),
    };
    const prompt = buildGoalContinuationPrompt(normalizedGoal);
    const result = await set(
      createQueueFirstZeroRun$,
      {
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
        apiStartTime: args.apiStartTime ?? now(),
        triggerSource: "workflow-event",
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
          runGroupId: normalizedGoal.goalId,
        },
        queueFirstAssociation: {
          kind: "goal_event",
          threadId: normalizedGoal.threadId,
          eventId: args.event.id,
          prompt,
          goalId: normalizedGoal.goalId,
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
      },
      signal,
    );
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
    const db = set(writeDb$);

    for (let attempt = 0; attempt < MAX_DRAIN_ATTEMPTS; attempt++) {
      const event = await loadNextGoalQueueEvent(
        db,
        args.chatThreadId,
        args.queueItemCreatedBefore,
      );
      signal.throwIfAborted();
      if (!event) {
        return;
      }

      const goal = await loadGoalQueueTarget(db, event);
      signal.throwIfAborted();
      if (!goal) {
        await rejectGoalEvent(db, event, GOAL_INVALIDATED_REASON, signal);
        continue;
      }

      const result = await set(
        launchQueuedGoal$,
        {
          event,
          goal,
          apiStartTime: args.apiStartTime,
          dispatchFailedCallbacks: args.dispatchFailedCallbacks,
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
          await rejectGoalEvent(db, event, GOAL_INVALIDATED_REASON, signal);
        }
        return;
      }

      const rejected = await rejectGoalEvent(
        db,
        event,
        result.response.body.error.message,
        signal,
      );
      const paused = rejected
        ? await pauseActiveGoalForThread(db, {
            orgId: goal.orgId,
            userId: goal.userId,
            threadId: goal.threadId,
          })
        : null;
      signal.throwIfAborted();
      log.warn("Goal queue event failed to create a run", {
        eventId: event.id,
        goalId: goal.goalId,
        code: result.response.body.error.code,
        rejected,
        pauseResult: paused?.kind ?? "not_paused",
      });
      return;
    }
  },
);
