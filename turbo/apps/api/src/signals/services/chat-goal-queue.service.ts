import {
  chatEvents,
  type ChatEventGoalSnapshot,
} from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { threadGoals } from "@vm0/db/schema/thread-goal";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, eq, gt, isNull, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "../external/db";
import {
  listPendingChatQueueEvents,
  loadPendingChatQueueEvent,
  lockChatQueueThread,
} from "./chat-event-queue.service";
import { insertChatEvent, replaceChatEvent } from "./zero-chat-event.service";
import { chatThreadAdmissionBlocked } from "./zero-chat-active-run.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { createUserMessageDocument } from "./zero-chat-user-message.service";

const goalEventRevoker = alias(chatEvents, "goal_event_revoker");
const laterGoalChange = alias(chatEvents, "later_goal_change");

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
}

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
            .select({ id: goalEventRevoker.id })
            .from(goalEventRevoker)
            .where(eq(goalEventRevoker.revokesEventId, chatEvents.id)),
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
  const goalSnapshot: ChatEventGoalSnapshot = {
    objectiveBrief: args.objectiveBrief,
  };
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
      runId: null,
      runGroupId: args.goalId,
      goalSnapshot,
    });
    if (!inserted) {
      throw new Error("Goal queue event insert returned no row");
    }
    return { kind: "inserted", eventId: inserted.id };
  });
}

function noGoalChangeAfterQueueEvent(db: Pick<Db, "select">) {
  return notExists(
    db
      .select({ id: laterGoalChange.id })
      .from(laterGoalChange)
      .where(
        and(
          eq(laterGoalChange.chatThreadId, chatEvents.chatThreadId),
          eq(laterGoalChange.eventType, "goal.changed"),
          gt(laterGoalChange.seqId, chatEvents.seqId),
        ),
      ),
  );
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
    if (await chatThreadAdmissionBlocked(tx, { threadId: chatThreadId })) {
      return null;
    }
    const pending = await listPendingChatQueueEvents(
      tx,
      chatThreadId,
      queueItemCreatedBefore,
    );
    const head = pending[0];
    if (!head || head.eventType !== "input.goal") {
      return null;
    }

    const [event] = await tx
      .select({
        id: chatEvents.id,
        chatThreadId: chatEvents.chatThreadId,
        userId: chatThreads.userId,
        orgId: zeroAgents.orgId,
        goalId: chatEvents.runGroupId,
        createdAt: chatEvents.createdAt,
      })
      .from(chatEvents)
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
      .where(eq(chatEvents.id, head.id))
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
  db: Pick<Db, "select">,
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
      status: threadGoals.status,
    })
    .from(threadGoals)
    .innerJoin(
      chatEvents,
      and(
        eq(chatEvents.id, event.id),
        eq(chatEvents.chatThreadId, threadGoals.chatThreadId),
      ),
    )
    .where(
      and(
        eq(threadGoals.id, event.goalId),
        eq(threadGoals.chatThreadId, event.chatThreadId),
        eq(threadGoals.orgId, event.orgId),
        eq(threadGoals.ownerUserId, event.userId),
        noGoalChangeAfterQueueEvent(db),
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
  };
}

/** Final-claim goal snapshot check after expensive run preparation. */
export async function goalQueueEventMatchesActiveGoal(
  db: Pick<Db, "select">,
  args: {
    readonly chatThreadId: string;
    readonly goalId: string;
    readonly eventId: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<boolean> {
  const [goal] = await db
    .select({
      status: threadGoals.status,
    })
    .from(threadGoals)
    .innerJoin(
      chatEvents,
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, threadGoals.chatThreadId),
      ),
    )
    .where(
      and(
        eq(threadGoals.id, args.goalId),
        eq(threadGoals.chatThreadId, args.chatThreadId),
        eq(threadGoals.orgId, args.orgId),
        eq(threadGoals.ownerUserId, args.userId),
        noGoalChangeAfterQueueEvent(db),
      ),
    )
    .limit(1);
  return goal?.status === "active";
}

async function pendingGoalEventStillExists(
  db: Pick<Db, "select">,
  args: { readonly chatThreadId: string; readonly eventId: string },
): Promise<boolean> {
  const pending = await loadPendingChatQueueEvent(db, args);
  return pending?.eventType === "input.goal";
}

/** Consume an invalid or failed goal trigger through the canonical reject edge. */
export async function rejectGoalQueueEvent(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly eventId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly reason: string;
  },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    if (!(await lockChatQueueThread(tx, args.chatThreadId))) {
      return false;
    }
    if (!(await pendingGoalEventStillExists(tx, args))) {
      return false;
    }
    const [payload] = await tx
      .select({
        goalSnapshot: chatEvents.goalSnapshot,
        currentGoalObjectiveBrief: threadGoals.objectiveBrief,
      })
      .from(chatEvents)
      .leftJoin(
        threadGoals,
        and(
          eq(threadGoals.chatThreadId, chatEvents.chatThreadId),
          eq(threadGoals.orgId, args.orgId),
          eq(threadGoals.ownerUserId, args.userId),
        ),
      )
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.chatThreadId),
        ),
      )
      .limit(1);
    if (!payload) {
      return false;
    }
    const objectiveBrief =
      payload.goalSnapshot?.objectiveBrief ??
      payload.currentGoalObjectiveBrief ??
      "Goal";
    const rejected = await replaceChatEvent(tx, args.eventId, {
      chatThreadId: args.chatThreadId,
      eventType: "input.rejected",
      userMessage: createUserMessageDocument({ text: objectiveBrief }),
      runId: null,
      error: args.reason,
      goalSnapshot: { objectiveBrief },
    });
    return rejected !== null;
  });
}
