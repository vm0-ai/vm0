import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { threadGoals } from "@vm0/db/schema/thread-goal";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, eq, gt, isNull, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Db } from "../external/db";
import { settle } from "../utils";
import {
  listPendingChatQueueEvents,
  loadChatAutomationIntakePause,
  loadPendingChatQueueEvent,
  lockChatQueueThread,
} from "./chat-event-queue.service";
import {
  decryptPersistentSecretsMap,
  encryptPersistentSecretsMap,
} from "./crypto.utils";
import { insertChatEvent, replaceChatEvent } from "./zero-chat-event.service";
import { chatThreadAdmissionBlocked } from "./zero-chat-active-run.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { createUserMessageDocument } from "./zero-chat-user-message.service";

const GOAL_QUEUE_EVENT_PARAMS_KEY = "__goal_queue_event_params__";
const goalEventRevoker = alias(chatMessages, "goal_event_revoker");
const laterGoalChange = alias(chatMessages, "later_goal_change");

const goalQueueEventParamsSchema = z.object({
  goalId: z.string().uuid(),
  callbackSecret: z.string().min(1),
});

interface GoalQueueEventParams {
  readonly goalId: string;
  readonly callbackSecret: string;
}

export type GoalQueueAdmission =
  | { readonly kind: "inserted"; readonly eventId: string }
  | { readonly kind: "coalesced" };

type GoalQueueAdmissionAttempt =
  | GoalQueueAdmission
  | { readonly kind: "payload-required" };

export interface PendingGoalQueueEvent {
  readonly id: string;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly encryptedParams: string;
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

async function encryptGoalQueueEventParams(
  params: GoalQueueEventParams,
  ctx: { readonly userId: string; readonly orgId: string },
): Promise<string> {
  const encrypted = await encryptPersistentSecretsMap(
    { [GOAL_QUEUE_EVENT_PARAMS_KEY]: JSON.stringify(params) },
    ctx,
  );
  if (!encrypted) {
    throw new Error("Failed to encrypt goal queue event params");
  }
  return encrypted;
}

export async function decryptGoalQueueEventParams(
  encryptedParams: string,
  ctx: { readonly userId: string; readonly orgId: string },
): Promise<GoalQueueEventParams | null> {
  const decrypted = await decryptPersistentSecretsMap(encryptedParams, ctx);
  const raw = decrypted?.[GOAL_QUEUE_EVENT_PARAMS_KEY];
  if (!raw) {
    return null;
  }
  return goalQueueEventParamsSchema.parse(JSON.parse(raw) as unknown);
}

async function pendingGoalEventExists(
  db: Pick<Db, "select">,
  chatThreadId: string,
): Promise<boolean> {
  const [event] = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, chatThreadId),
        chatEventTypeIn(["input.goal"]),
        isNull(chatMessages.runId),
        notExists(
          db
            .select({ id: goalEventRevoker.id })
            .from(goalEventRevoker)
            .where(eq(goalEventRevoker.revokesEventId, chatMessages.id)),
        ),
      ),
    )
    .limit(1);
  return event !== undefined;
}

async function attemptGoalQueueAdmission(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly encryptedParams: string | undefined;
    readonly objectiveBrief: string;
  },
): Promise<GoalQueueAdmissionAttempt> {
  return await db.transaction(async (tx) => {
    if (!(await lockChatQueueThread(tx, args.chatThreadId))) {
      throw new Error("Goal chat thread no longer exists");
    }
    if (await pendingGoalEventExists(tx, args.chatThreadId)) {
      return { kind: "coalesced" };
    }
    if (args.encryptedParams === undefined) {
      return { kind: "payload-required" };
    }
    const inserted = await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "input.goal",
      content: null,
      runId: null,
      encryptedParams: args.encryptedParams,
      goalSnapshot: { objectiveBrief: args.objectiveBrief },
    });
    if (!inserted) {
      throw new Error("Goal queue event insert returned no row");
    }
    return { kind: "inserted", eventId: inserted.id };
  });
}

/** Persist one coalesced goal continuation trigger without preparing its run. */
export async function admitGoalQueueEvent(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly objectiveBrief: string;
    readonly params: GoalQueueEventParams;
  },
): Promise<GoalQueueAdmission> {
  const initial = await attemptGoalQueueAdmission(db, {
    chatThreadId: args.chatThreadId,
    encryptedParams: undefined,
    objectiveBrief: args.objectiveBrief,
  });
  if (initial.kind !== "payload-required") {
    return initial;
  }

  const encrypted = await settle(
    encryptGoalQueueEventParams(args.params, {
      orgId: args.orgId,
      userId: args.userId,
    }),
  );
  if (!encrypted.ok) {
    const retryWithoutPayload = await attemptGoalQueueAdmission(db, {
      chatThreadId: args.chatThreadId,
      encryptedParams: undefined,
      objectiveBrief: args.objectiveBrief,
    });
    if (retryWithoutPayload.kind !== "payload-required") {
      return retryWithoutPayload;
    }
    throw encrypted.error;
  }

  const final = await attemptGoalQueueAdmission(db, {
    chatThreadId: args.chatThreadId,
    encryptedParams: encrypted.value,
    objectiveBrief: args.objectiveBrief,
  });
  if (final.kind === "payload-required") {
    throw new Error("Goal queue admission still required encrypted params");
  }
  return final;
}

function runnableGoalHead(
  pending: Awaited<ReturnType<typeof listPendingChatQueueEvents>>,
  automationPaused: boolean,
) {
  return automationPaused
    ? pending.find((event) => {
        return event.eventType !== "input.automation";
      })
    : pending[0];
}

function noGoalChangeAfterQueueEvent(db: Pick<Db, "select">) {
  return notExists(
    db
      .select({ id: laterGoalChange.id })
      .from(laterGoalChange)
      .where(
        and(
          eq(laterGoalChange.chatThreadId, chatMessages.chatThreadId),
          eq(laterGoalChange.eventType, "goal.changed"),
          gt(laterGoalChange.seqId, chatMessages.seqId),
        ),
      ),
  );
}

/** Load the next runnable goal trigger without letting automation pause gate it. */
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
    const automationPause = await loadChatAutomationIntakePause(
      tx,
      chatThreadId,
    );
    const head = runnableGoalHead(pending, automationPause !== null);
    if (!head || head.eventType !== "input.goal") {
      return null;
    }

    const [event] = await tx
      .select({
        id: chatMessages.id,
        chatThreadId: chatMessages.chatThreadId,
        userId: chatThreads.userId,
        orgId: zeroAgents.orgId,
        encryptedParams: chatMessages.encryptedParams,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
      .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
      .where(eq(chatMessages.id, head.id))
      .limit(1);
    if (!event) {
      return null;
    }
    if (!event.encryptedParams) {
      throw new Error(`Goal queue event ${event.id} is missing its payload`);
    }
    return { ...event, encryptedParams: event.encryptedParams };
  });
}

export async function loadGoalQueueTarget(
  db: Pick<Db, "select">,
  event: PendingGoalQueueEvent,
  goalId: string,
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
      chatMessages,
      and(
        eq(chatMessages.id, event.id),
        eq(chatMessages.chatThreadId, threadGoals.chatThreadId),
      ),
    )
    .where(
      and(
        eq(threadGoals.id, goalId),
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
      chatMessages,
      and(
        eq(chatMessages.id, args.eventId),
        eq(chatMessages.chatThreadId, threadGoals.chatThreadId),
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
    const [pending] = await tx
      .select({ goalSnapshot: chatMessages.goalSnapshot })
      .from(chatMessages)
      .where(eq(chatMessages.id, args.eventId))
      .limit(1);
    let objectiveBrief = pending?.goalSnapshot?.objectiveBrief;
    if (!objectiveBrief) {
      const [goal] = await tx
        .select({ objectiveBrief: threadGoals.objectiveBrief })
        .from(threadGoals)
        .where(eq(threadGoals.chatThreadId, args.chatThreadId))
        .limit(1);
      objectiveBrief = goal?.objectiveBrief ?? "Goal continuation";
    }
    const rejected = await replaceChatEvent(tx, args.eventId, {
      chatThreadId: args.chatThreadId,
      eventType: "input.rejected",
      content: objectiveBrief,
      userMessage: createUserMessageDocument({ text: objectiveBrief }),
      runId: null,
      error: args.reason,
      goalSnapshot: { objectiveBrief },
    });
    return rejected !== null;
  });
}
