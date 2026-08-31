import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { threadGoals } from "@okouai/db/schema/thread-goal";
import { agents } from "@okouai/db/schema/agent";
import { and, asc, eq, isNull, lt, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  loadPendingChatQueueEvent,
  lockChatQueueThread,
  pendingChatQueueEventCondition,
} from "./chat-event-queue.service";
import {
  insertChatEvent,
  revokeChatEvent,
  replaceChatEvent,
} from "./chat-event.service";
import { chatThreadAdmissionAllowedCondition } from "./chat-active-run.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { appendGoalCloseMarker } from "./chat-goal-marker.service";
import { createUserMessageDocument } from "./chat-user-message.service";
import { lockGoalThread } from "./goal-lock.service";
import {
  canonicalChatEventGoalId,
  canonicalChatEventUserMessage,
} from "./canonical-chat-event-read.service";

const goalInputRevoker = alias(chatEvents, "goal_input_revoker");

export type GoalQueueAdmission =
  | { readonly kind: "inserted"; readonly eventId: string }
  | { readonly kind: "coalesced" };

export interface PendingGoalQueueEvent {
  readonly id: string;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly goalId: string;
  readonly createdAt: Date;
}

export interface GoalQueueTarget {
  readonly goalId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly agentId: string;
  readonly objective: string;
  readonly objectiveBrief: string;
  readonly autonomyBudget: number;
  readonly stateRevision: string;
}

type FailedGoalQueueSettlement =
  | { readonly kind: "not_pending" }
  | { readonly kind: "revoked" }
  | { readonly kind: "stale" }
  | { readonly kind: "rejected"; readonly goalId: string };

async function pendingGoalEventExists(
  db: Pick<Db, "select">,
  chatThreadId: string,
): Promise<boolean> {
  const [event] = await db
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreadId),
        chatEventTypeIn(["input.goal"]),
        isNull(chatEvents.runId),
        notExists(
          db
            .select({ id: goalInputRevoker.id })
            .from(goalInputRevoker)
            .where(eq(goalInputRevoker.revokesEventId, chatEvents.id)),
        ),
      ),
    )
    .limit(1);
  return event !== undefined;
}

/** Persist one coalesced goal continuation trigger without preparing its run. */
export async function admitGoalQueueEvent(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly goalId: string;
    readonly objectiveBrief: string;
  },
): Promise<GoalQueueAdmission> {
  return await db.transaction(async (tx) => {
    if (!(await lockChatQueueThread(tx, args.chatThreadId))) {
      throw new Error("Goal chat thread no longer exists");
    }
    if (await pendingGoalEventExists(tx, args.chatThreadId)) {
      return { kind: "coalesced" };
    }
    const inserted = await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "input.goal",
      content: null,
      contextType: "goal",
      runId: null,
      runGroupId: args.goalId,
      userMessage: createUserMessageDocument({
        text: null,
        nonContentPart: {
          type: "goal",
          goalBrief: args.objectiveBrief,
        },
      }),
    });
    if (!inserted) {
      throw new Error("Goal queue event insert returned no row");
    }
    return { kind: "inserted", eventId: inserted.id };
  });
}

/** Load the next runnable goal trigger. */
export async function loadNextGoalQueueEvent(
  db: Db,
  chatThreadId: string,
  queueItemCreatedBefore?: Date,
): Promise<PendingGoalQueueEvent | null> {
  return await db.transaction(async (tx) => {
    if (!(await lockChatQueueThread(tx, chatThreadId))) {
      return null;
    }

    const [event] = await tx
      .select({
        id: chatEvents.id,
        chatThreadId: chatEvents.chatThreadId,
        userId: chatThreads.userId,
        orgId: agents.orgId,
        goalId: canonicalChatEventGoalId(),
        createdAt: chatEvents.createdAt,
      })
      .from(chatEvents)
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(
        and(
          eq(chatEvents.chatThreadId, chatThreadId),
          pendingChatQueueEventCondition(tx),
          chatEventTypeIn(["input.goal"]),
          queueItemCreatedBefore
            ? lt(chatEvents.createdAt, queueItemCreatedBefore)
            : undefined,
          notExists(
            tx
              .select({ id: chatEvents.id })
              .from(chatEvents)
              .where(
                and(
                  eq(chatEvents.chatThreadId, chatThreadId),
                  pendingChatQueueEventCondition(tx),
                  chatEventTypeIn(["input.prompt", "input.automation"]),
                  queueItemCreatedBefore
                    ? lt(chatEvents.createdAt, queueItemCreatedBefore)
                    : undefined,
                ),
              ),
          ),
          chatThreadAdmissionAllowedCondition(tx, {
            threadId: chatThreadId,
          }),
        ),
      )
      .orderBy(asc(chatEvents.createdAt), asc(chatEvents.id))
      .limit(1);
    if (!event) {
      return null;
    }
    if (!event.goalId) {
      throw new Error(`Goal queue event ${event.id} is missing its goal id`);
    }
    return { ...event, goalId: event.goalId };
  });
}

export async function loadGoalQueueTarget(
  db: Db,
  event: PendingGoalQueueEvent,
): Promise<GoalQueueTarget | null> {
  const [goal] = await db
    .select({
      goalId: threadGoals.id,
      orgId: threadGoals.orgId,
      userId: threadGoals.ownerUserId,
      threadId: threadGoals.chatThreadId,
      agentId: threadGoals.agentId,
      objective: threadGoals.objective,
      objectiveBrief: threadGoals.objectiveBrief,
      autonomyBudget: threadGoals.autonomyBudget,
      status: threadGoals.status,
      // A Date decoder drops PostgreSQL microseconds needed by the final CAS.
      stateRevision: sql`${threadGoals.updatedAt}::text`.mapWith(pgTextDecoder),
    })
    .from(threadGoals)
    .innerJoin(
      chatEvents,
      and(
        eq(chatEvents.id, event.id),
        eq(chatEvents.chatThreadId, threadGoals.chatThreadId),
        eq(chatEvents.contextType, "goal"),
        eq(chatEvents.contextId, threadGoals.id),
      ),
    )
    .where(
      and(
        eq(threadGoals.id, event.goalId),
        eq(threadGoals.chatThreadId, event.chatThreadId),
        eq(threadGoals.orgId, event.orgId),
        eq(threadGoals.ownerUserId, event.userId),
      ),
    )
    .limit(1);
  if (!goal || goal.status !== "active") {
    return null;
  }
  return {
    goalId: goal.goalId,
    orgId: goal.orgId,
    userId: goal.userId,
    threadId: goal.threadId,
    agentId: goal.agentId,
    objective: goal.objective,
    objectiveBrief: goal.objectiveBrief,
    autonomyBudget: goal.autonomyBudget,
    stateRevision: goal.stateRevision,
  };
}

async function pendingGoalEventStillExists(
  db: Pick<Db, "select">,
  args: { readonly chatThreadId: string; readonly eventId: string },
): Promise<boolean> {
  const pending = await loadPendingChatQueueEvent(db, args);
  return pending?.eventType === "input.goal";
}

async function lockGoalQueueTarget(
  db: Db,
  event: PendingGoalQueueEvent,
): Promise<void> {
  await db
    .select({ id: threadGoals.id })
    .from(threadGoals)
    .where(
      and(
        eq(threadGoals.id, event.goalId),
        eq(threadGoals.chatThreadId, event.chatThreadId),
        eq(threadGoals.orgId, event.orgId),
        eq(threadGoals.ownerUserId, event.userId),
      ),
    )
    .for("update")
    .limit(1);
}

/** Remove a goal trigger invalidated by a normal goal lifecycle change. */
export async function revokeGoalQueueEvent(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly eventId: string;
  },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    if (!(await lockChatQueueThread(tx, args.chatThreadId))) {
      return false;
    }
    if (!(await pendingGoalEventStillExists(tx, args))) {
      return false;
    }
    const revoked = await revokeChatEvent(tx, args.eventId, {
      chatThreadId: args.chatThreadId,
      eventType: "control.revoke",
      runId: null,
    });
    return revoked !== null;
  });
}

/**
 * Settle a failed launch against the final goal state. Goal lifecycle writers
 * take the advisory lock before changing the goal row. Lock the exact source
 * row before the chat queue row so validity, event transition, and the
 * exact-goal pause share the same serialization order as final run claim.
 */
export async function settleFailedGoalQueueEvent(
  db: Db,
  args: {
    readonly event: PendingGoalQueueEvent;
    readonly expectedGoalStateRevision: string;
    readonly reason: string;
  },
): Promise<FailedGoalQueueSettlement> {
  return await db.transaction(async (tx) => {
    await lockGoalThread(tx, args.event.chatThreadId);
    await lockGoalQueueTarget(tx, args.event);
    if (!(await lockChatQueueThread(tx, args.event.chatThreadId))) {
      return { kind: "not_pending" };
    }
    if (
      !(await pendingGoalEventStillExists(tx, {
        chatThreadId: args.event.chatThreadId,
        eventId: args.event.id,
      }))
    ) {
      return { kind: "not_pending" };
    }

    const goal = await loadGoalQueueTarget(tx, args.event);
    if (!goal) {
      const revoked = await revokeChatEvent(tx, args.event.id, {
        chatThreadId: args.event.chatThreadId,
        eventType: "control.revoke",
        runId: null,
      });
      return revoked ? { kind: "revoked" } : { kind: "not_pending" };
    }
    if (goal.stateRevision !== args.expectedGoalStateRevision) {
      return { kind: "stale" };
    }

    const [payload] = await tx
      .select({
        userMessage: canonicalChatEventUserMessage(),
        currentGoalObjectiveBrief: threadGoals.objectiveBrief,
      })
      .from(chatEvents)
      .leftJoin(
        threadGoals,
        and(
          eq(threadGoals.id, goal.goalId),
          eq(threadGoals.chatThreadId, chatEvents.chatThreadId),
          eq(threadGoals.orgId, goal.orgId),
          eq(threadGoals.ownerUserId, goal.userId),
        ),
      )
      .where(
        and(
          eq(chatEvents.id, args.event.id),
          eq(chatEvents.chatThreadId, args.event.chatThreadId),
        ),
      )
      .limit(1);
    if (!payload) {
      return { kind: "not_pending" };
    }
    const goalPart = payload.userMessage?.parts.find((part) => {
      return part.type === "goal";
    });
    const objectiveBrief =
      goalPart?.goalBrief ?? payload.currentGoalObjectiveBrief ?? "Goal";
    const rejected = await replaceChatEvent(tx, args.event.id, {
      chatThreadId: args.event.chatThreadId,
      eventType: "input.rejected",
      userMessage: createUserMessageDocument({
        text: null,
        nonContentPart: {
          type: "goal",
          goalBrief: objectiveBrief,
        },
      }),
      runId: null,
      error: args.reason,
    });
    if (!rejected) {
      return { kind: "not_pending" };
    }

    const [paused] = await tx
      .update(threadGoals)
      .set({ status: "paused", updatedAt: nowDate() })
      .where(
        and(
          eq(threadGoals.id, goal.goalId),
          eq(threadGoals.chatThreadId, goal.threadId),
          eq(threadGoals.orgId, goal.orgId),
          eq(threadGoals.ownerUserId, goal.userId),
          eq(threadGoals.status, "active"),
        ),
      )
      .returning({ goalId: threadGoals.id });
    if (!paused) {
      throw new Error("Failed to pause the validated goal queue target");
    }
    await appendGoalCloseMarker(tx, {
      chatThreadId: goal.threadId,
    });
    return { kind: "rejected", goalId: paused.goalId };
  });
}
