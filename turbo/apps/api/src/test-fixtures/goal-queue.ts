import { chatEvents } from "@okouai/db/schema/chat-event";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { threadGoals } from "@okouai/db/schema/thread-goal";
import { createStore } from "ccstate";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "../lib/db";
import { dispatchFailedRunCallbacks } from "../signals/services/agent-run-callback.service";
import {
  admitGoalQueueEvent,
  type GoalQueueAdmission,
} from "../signals/services/chat-goal-queue.service";
import { drainChatThreadQueueForThread$ } from "../signals/services/chat-thread-queue-drain.service";

interface GoalQueueAdmissionFixtureArgs {
  readonly threadId: string;
  readonly goalId: string;
  readonly objectiveBrief: string;
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
    goalId: args.goalId,
    objectiveBrief: args.objectiveBrief,
  });
}

/** Read queue source event ids and admitted goal-run ids for route assertions. */
export async function readGoalQueueStateFixture(threadId: string): Promise<{
  readonly eventIds: readonly string[];
  readonly runIds: readonly string[];
  readonly runs: readonly {
    readonly id: string;
    readonly goalId: string | null;
  }[];
}> {
  const [events, runs] = await Promise.all([
    db()
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, threadId),
          eq(chatEvents.eventType, "input.goal"),
        ),
      ),
    db()
      .select({
        id: agentRuns.id,
        goalId: agentRuns.goalId,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.chatThreadId, threadId),
          isNotNull(agentRuns.goalId),
          isNotNull(agentRuns.triggerSource),
        ),
      ),
  ]);
  return {
    eventIds: events.map((event) => {
      return event.id;
    }),
    runIds: runs.map((run) => {
      return run.id;
    }),
    runs,
  };
}

/** Run the same shared scheduler that follows production goal admission. */
export async function drainChatThreadQueueFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
  readonly queueItemCreatedBefore?: Date;
}): Promise<void> {
  await createStore().set(
    drainChatThreadQueueForThread$,
    {
      chatThreadId: args.threadId,
      dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      queueItemCreatedBefore: args.queueItemCreatedBefore,
    },
    args.signal,
  );
}

/** Move one goal trigger before a stale-sweep cutoff. */
export async function setGoalQueueEventCreatedAtFixture(args: {
  readonly eventId: string;
  readonly createdAt: Date;
}): Promise<void> {
  const updated = await db().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    return await tx
      .update(chatEvents)
      .set({ createdAt: args.createdAt })
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.eventType, "input.goal"),
        ),
      )
      .returning({ id: chatEvents.id });
  });
  if (updated.length !== 1) {
    throw new Error("Expected one goal queue event to become historical");
  }
}

/** Invalidate a goal without triggering a separate queue drain. */
export async function pauseGoalQueueTargetFixture(
  goalId: string,
): Promise<void> {
  const [goal] = await db()
    .update(threadGoals)
    .set({ status: "paused" })
    .where(eq(threadGoals.id, goalId))
    .returning({ id: threadGoals.id });
  if (!goal) {
    throw new Error("Expected the goal queue target fixture");
  }
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
    goalId: goal.id,
    objectiveBrief: args.objectiveBrief,
  });
  if (admission.kind !== "inserted") {
    throw new Error("Expected the goal fixture event to be inserted");
  }
  return { goalId: goal.id, eventId: admission.eventId };
}
