import { chatMessages } from "@vm0/db/schema/chat-message";
import { threadGoals } from "@vm0/db/schema/thread-goal";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { createStore } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "../lib/db";
import {
  admitGoalQueueEvent,
  type GoalQueueAdmission,
} from "../signals/services/chat-goal-queue.service";
import { drainChatThreadQueueForThread$ } from "../signals/services/chat-thread-queue-drain.service";
import { insertChatEvent } from "../signals/services/zero-chat-event.service";

interface GoalQueueAdmissionFixtureArgs {
  readonly threadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly goalId: string;
  readonly objectiveBrief: string;
  readonly callbackSecret: string;
}

/**
 * Admit the internal trigger through its production service. No product API
 * exposes a standalone goal-continuation trigger; callers normally reach this
 * boundary from bootstrap or terminal callback processing.
 */
export async function admitGoalQueueEventFixture(
  args: GoalQueueAdmissionFixtureArgs,
): Promise<GoalQueueAdmission> {
  return await admitGoalQueueEvent(db(), {
    chatThreadId: args.threadId,
    orgId: args.orgId,
    userId: args.userId,
    objectiveBrief: args.objectiveBrief,
    params: {
      goalId: args.goalId,
      callbackSecret: args.callbackSecret,
    },
  });
}

/**
 * Start a second production drain to reproduce claim races that cannot be
 * scheduled through an external route at a deterministic boundary.
 */
export async function drainChatThreadQueueFixture(
  threadId: string,
  signal: AbortSignal,
): Promise<void> {
  await createStore().set(
    drainChatThreadQueueForThread$,
    {
      chatThreadId: threadId,
      dispatchFailedCallbacks: async () => {},
    },
    signal,
  );
}

/**
 * Read internal queue facts that are deliberately absent from materialized
 * thread APIs: source input.goal ids and admitted goal-run ids.
 */
export async function readGoalQueueStateFixture(threadId: string): Promise<{
  readonly eventIds: readonly string[];
  readonly runIds: readonly string[];
}> {
  const [events, runs] = await Promise.all([
    db()
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, threadId),
          eq(chatMessages.eventType, "input.goal"),
        ),
      ),
    db()
      .select({ id: zeroRuns.id })
      .from(zeroRuns)
      .where(
        and(eq(zeroRuns.chatThreadId, threadId), isNotNull(zeroRuns.goalId)),
      ),
  ]);
  return {
    eventIds: events.map((event) => {
      return event.id;
    }),
    runIds: runs.map((run) => {
      return run.id;
    }),
  };
}

/**
 * Resolve the thread provisioned for a goal created from a non-chat run. The
 * goal API intentionally does not expose its backing thread id.
 */
export async function readGoalThreadFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId?: string;
  readonly threadId?: string;
}): Promise<{ readonly goalId: string; readonly threadId: string } | null> {
  const [goal] = await db()
    .select({
      goalId: threadGoals.id,
      threadId: threadGoals.chatThreadId,
    })
    .from(threadGoals)
    .where(
      and(
        eq(threadGoals.orgId, args.orgId),
        eq(threadGoals.ownerUserId, args.userId),
        args.agentId ? eq(threadGoals.agentId, args.agentId) : undefined,
        args.threadId ? eq(threadGoals.chatThreadId, args.threadId) : undefined,
      ),
    )
    .limit(1);
  return goal ?? null;
}

/**
 * Create an active goal and its pending internal trigger on an existing
 * automation thread. The product does not offer a cross-source setup endpoint;
 * this narrow fixture makes the shared queue-priority invariant observable.
 */
export async function createActiveGoalQueueEventFixture(args: {
  readonly threadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly objective: string;
  readonly objectiveBrief: string;
  readonly callbackSecret: string;
}): Promise<{ readonly goalId: string; readonly eventId: string }> {
  const [goal] = await db()
    .insert(threadGoals)
    .values({
      orgId: args.orgId,
      ownerUserId: args.userId,
      agentId: args.agentId,
      chatThreadId: args.threadId,
      status: "active",
      objective: args.objective,
      objectiveBrief: args.objectiveBrief,
    })
    .returning({ id: threadGoals.id });
  if (!goal) {
    throw new Error("Expected the active goal fixture");
  }
  const admission = await admitGoalQueueEventFixture({
    threadId: args.threadId,
    orgId: args.orgId,
    userId: args.userId,
    goalId: goal.id,
    objectiveBrief: args.objectiveBrief,
    callbackSecret: args.callbackSecret,
  });
  if (admission.kind !== "inserted") {
    throw new Error("Expected the goal fixture event to be inserted");
  }
  return { goalId: goal.id, eventId: admission.eventId };
}

/**
 * Append an automation-intake pause without inducing a provider failure. This
 * isolates the contract that automation pause never gates goal continuation.
 */
export async function appendAutomationPauseFixture(args: {
  readonly threadId: string;
  readonly reason: string;
}): Promise<void> {
  await db().transaction(async (tx) => {
    await insertChatEvent(tx, {
      chatThreadId: args.threadId,
      eventType: "queue.automation_paused",
      content: null,
      runId: null,
      pauseReason: args.reason,
    });
  });
}
