import { randomBytes } from "node:crypto";

import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { settle } from "../utils";
import type { DispatchFailedRunCallbacks } from "./agent-run-create.service";
import { admitGoalQueueEvent } from "./chat-goal-queue.service";
import { drainChatThreadQueueForThread$ } from "./chat-thread-queue-drain.service";
import {
  loadActiveGoalForThread,
  pauseActiveGoalForThread,
  type GoalBootstrap,
} from "./zero-goal.service";

const log = logger("api:zero-goal-continuation");

type TerminalRunStatus = "completed" | "failed" | "timeout" | "cancelled";

interface TerminatingRunContext {
  readonly runId: string;
  readonly status: string;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string | null;
}

type GoalEnqueueResult =
  | {
      readonly kind: "enqueued";
      readonly goalId: string;
      readonly eventId: string;
    }
  | { readonly kind: "coalesced"; readonly goalId: string }
  | {
      readonly kind: "failed-to-enqueue";
      readonly goalId: string;
      readonly error: string;
    };

type GoalContinuationResult =
  | { readonly kind: "skipped"; readonly reason: string }
  | GoalEnqueueResult
  | { readonly kind: "paused"; readonly goalId: string };

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

const enqueueGoalContinuation$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly goal: GoalBootstrap;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
    signal: AbortSignal,
  ): Promise<GoalEnqueueResult> => {
    const admission = await settle(
      admitGoalQueueEvent(args.db, {
        chatThreadId: args.goal.threadId,
        orgId: args.goal.orgId,
        userId: args.goal.userId,
        objectiveBrief: args.goal.objectiveBrief,
        params: {
          goalId: args.goal.goalId,
          callbackSecret: generateCallbackSecret(),
        },
      }),
    );
    signal.throwIfAborted();
    if (!admission.ok) {
      const paused = await pauseActiveGoalForThread(args.db, {
        orgId: args.goal.orgId,
        userId: args.goal.userId,
        threadId: args.goal.threadId,
      });
      signal.throwIfAborted();
      const message = errorMessage(admission.error);
      log.warn("Goal continuation enqueue failed; goal paused", {
        goalId: args.goal.goalId,
        error: message,
        pauseResult: paused.kind,
      });
      return {
        kind: "failed-to-enqueue",
        goalId: args.goal.goalId,
        error: message,
      };
    }

    await set(
      drainChatThreadQueueForThread$,
      {
        chatThreadId: args.goal.threadId,
        dispatchFailedCallbacks: args.dispatchFailedCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();

    return admission.value.kind === "inserted"
      ? {
          kind: "enqueued",
          goalId: args.goal.goalId,
          eventId: admission.value.eventId,
        }
      : { kind: "coalesced", goalId: args.goal.goalId };
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
    const run = await loadTerminatingRun(args.db, args.runId);
    signal.throwIfAborted();
    if (!run?.chatThreadId) {
      return { kind: "skipped", reason: "run-not-linked-to-chat-thread" };
    }
    if (!isTerminalStatus(run.status)) {
      return { kind: "skipped", reason: "run-not-terminal" };
    }
    const goal = await loadActiveGoalForThread(args.db, {
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
      const paused = await pauseActiveGoalForThread(args.db, {
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

    return await set(
      enqueueGoalContinuation$,
      {
        db: args.db,
        goal: {
          goalId: goal.id,
          orgId: goal.orgId,
          userId: goal.ownerUserId,
          threadId: goal.chatThreadId,
          objectiveBrief: goal.objectiveBrief,
        },
        dispatchFailedCallbacks: args.dispatchFailedCallbacks,
      },
      signal,
    );
  },
);

export const bootstrapGoalRun$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly goal: GoalBootstrap;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
    signal: AbortSignal,
  ): Promise<GoalEnqueueResult> => {
    return await set(enqueueGoalContinuation$, args, signal);
  },
);
