/** Typed append-only commands for the canonical ChatEvent stream. */
import {
  chatEventRunLifecycle,
  isValidChatEventRevocation,
} from "@vm0/api-contracts/contracts/chat-events";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { eq, isNotNull, sql } from "drizzle-orm";

import type { Db } from "../external/db";
import { nowDate } from "../external/time";

type ChatEventInsert = typeof chatMessages.$inferInsert;
type ChatEventWriteTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

type ChatEventIdentity = Pick<
  ChatEventInsert,
  | "id"
  | "chatThreadId"
  | "runId"
  | "runGroupId"
  | "slackMessagePermalink"
  | "feishuChatOpenUrl"
> & {
  readonly createdAt?: Date;
};

type ChatEventInputPayload = Pick<
  ChatEventInsert,
  "attachFiles" | "attachFileMetadata" | "generationTemplate" | "goalSnapshot"
> & {
  readonly userMessage: NonNullable<ChatEventInsert["userMessage"]>;
};

type ChatEventOutputSequence = Pick<
  ChatEventInsert,
  "sequenceNumber" | "runEventId"
>;

type InputPromptEvent = ChatEventIdentity &
  ChatEventInputPayload & {
    readonly eventType: "input.prompt";
    readonly content: string | null;
    readonly triggerSource?: TriggerSource;
    readonly encryptedParams?: string | null;
  };

type InputAutomationEvent = ChatEventIdentity & {
  readonly eventType: "input.automation";
  readonly content?: null;
  readonly automationId: string;
  readonly triggerSource: TriggerSource;
  readonly triggerBrief: string | null;
  readonly encryptedParams: string;
};

type InputRejectedEvent = ChatEventIdentity &
  ChatEventInputPayload &
  Pick<ChatEventInsert, "sequenceNumber"> & {
    readonly eventType: "input.rejected";
    readonly content: string | null;
    readonly error: string;
    readonly automationId?: string;
    readonly triggerSource?: TriggerSource;
    readonly triggerBrief?: string | null;
  };

type OutputMessageEvent = ChatEventIdentity &
  ChatEventOutputSequence & {
    readonly eventType: "output.message";
    readonly content: string;
  };

type OutputErrorEvent = ChatEventIdentity &
  Pick<ChatEventInsert, "sequenceNumber"> & {
    readonly eventType: "output.error";
    readonly content: string | null;
    readonly error: string;
  };

type OutputThinkingEvent = ChatEventIdentity &
  Pick<ChatEventInsert, "runEventId"> & {
    readonly eventType: "output.thinking";
    readonly content?: null;
    readonly thinking: string;
  };

type OutputFollowupsEvent = ChatEventIdentity & {
  readonly eventType: "output.followups";
  readonly content?: null;
  readonly recommendedFollowups: NonNullable<
    ChatEventInsert["recommendedFollowups"]
  >;
};

type RunQueuedEvent = ChatEventIdentity & {
  readonly eventType: "run.queued";
  readonly runId: string;
  readonly content: string;
  readonly runEventId: "queue:queued";
};

type RunDequeuedEvent = ChatEventIdentity & {
  readonly eventType: "run.dequeued";
  readonly runId: string;
  readonly content?: null;
  readonly runEventId: "queue:dequeued";
};

type RunCompletedEvent = ChatEventIdentity & {
  readonly eventType: "run.completed";
  readonly runId: string;
  readonly content?: string | null;
};

type RunFailedEvent = ChatEventIdentity & {
  readonly eventType: "run.failed";
  readonly runId: string;
  readonly content?: string | null;
  readonly error?: string;
};

type RunCancelledEvent = ChatEventIdentity & {
  readonly eventType: "run.cancelled";
  readonly runId: string;
  readonly content?: string | null;
  readonly error?: string;
};

type QueueAutomationPausedEvent = ChatEventIdentity & {
  readonly eventType: "queue.automation_paused";
  readonly content?: null;
  readonly pauseReason: string | null;
};

type QueueAutomationResumedEvent = ChatEventIdentity & {
  readonly eventType: "queue.automation_resumed";
  readonly content?: null;
};

type ControlInterruptEvent = ChatEventIdentity & {
  readonly eventType: "control.interrupt";
  readonly content?: null;
  readonly interruptsRunId: string;
  readonly attachFiles?: null;
};

type ControlRevokeEvent = ChatEventIdentity & {
  readonly eventType: "control.revoke";
  readonly content?: null;
};

type GoalChangedEvent = ChatEventIdentity & {
  readonly eventType: "goal.changed";
  readonly content?: null;
  readonly goalEvent: NonNullable<ChatEventInsert["goalEvent"]>;
  readonly runEventId?: null;
};

type UsageRecordedEvent = ChatEventIdentity & {
  readonly eventType: "usage.recorded";
  readonly runId: string;
  readonly content?: null;
  readonly usagePayload: NonNullable<ChatEventInsert["usagePayload"]>;
};

export type NewChatEvent =
  | InputPromptEvent
  | InputAutomationEvent
  | InputRejectedEvent
  | OutputMessageEvent
  | OutputErrorEvent
  | OutputThinkingEvent
  | OutputFollowupsEvent
  | RunQueuedEvent
  | RunDequeuedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | QueueAutomationPausedEvent
  | QueueAutomationResumedEvent
  | ControlInterruptEvent
  | ControlRevokeEvent
  | GoalChangedEvent
  | UsageRecordedEvent;

type AppendChatEvent = Exclude<
  NewChatEvent,
  RunDequeuedEvent | ControlRevokeEvent
>;

interface ChatEventCommandResult {
  readonly id: string;
  readonly createdAt: Date;
  readonly seqId: number;
}

interface ChatEventBatchCommandResult {
  readonly id: string;
  readonly createdAt: Date;
  readonly seqId: number;
  readonly sequenceNumber: number | null;
}

type InsertChatEventConflict = "none" | "any" | "id" | "run-lifecycle";
type InsertChatEventsConflict = "any" | "run-sequence";

type PersistedChatEvent = Omit<ChatEventInsert, "role" | "seqId">;

function persistedChatEventValues(values: NewChatEvent): PersistedChatEvent {
  const runLifecycleEvent = chatEventRunLifecycle(values.eventType);
  if (values.eventType === "queue.automation_paused") {
    const { pauseReason, ...event } = values;
    return {
      ...event,
      content: null,
      error: pauseReason,
      eventType: event.eventType,
    };
  }
  return {
    ...values,
    ...(values.eventType === "input.automation" ||
    values.eventType === "queue.automation_resumed"
      ? { content: null }
      : {}),
    eventType: values.eventType,
    ...(runLifecycleEvent === null ? {} : { runLifecycleEvent }),
  };
}

async function reserveChatEventSeqIds(
  tx: ChatEventWriteTransaction,
  chatThreadId: string,
  count: number,
): Promise<number> {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("chat event seq_id reservation count must be positive");
  }

  const [thread] = await tx
    .update(chatThreads)
    .set({
      lastChatMessageSeqId: sql`${chatThreads.lastChatMessageSeqId} + ${count}`,
    })
    .where(eq(chatThreads.id, chatThreadId))
    .returning({ lastSeqId: chatThreads.lastChatMessageSeqId });
  if (!thread) {
    throw new Error(`Chat thread ${chatThreadId} not found`);
  }
  return thread.lastSeqId - count + 1;
}

async function addSeqIdsToEvents(
  tx: ChatEventWriteTransaction,
  values: readonly PersistedChatEvent[],
): Promise<readonly (PersistedChatEvent & { readonly seqId: number })[]> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value.chatThreadId, (counts.get(value.chatThreadId) ?? 0) + 1);
  }

  const nextSeqIdByThread = new Map<string, number>();
  for (const [chatThreadId, count] of [...counts].sort(([left], [right]) => {
    return left.localeCompare(right);
  })) {
    nextSeqIdByThread.set(
      chatThreadId,
      await reserveChatEventSeqIds(tx, chatThreadId, count),
    );
  }

  return values.map((value) => {
    const seqId = nextSeqIdByThread.get(value.chatThreadId);
    if (seqId === undefined) {
      throw new Error(`Chat thread ${value.chatThreadId} was not reserved`);
    }
    nextSeqIdByThread.set(value.chatThreadId, seqId + 1);
    return { ...value, seqId };
  });
}

/** Insert an immutable chat event using the caller-owned transaction. */
export async function insertChatEvent(
  tx: ChatEventWriteTransaction,
  values: AppendChatEvent,
  conflict: InsertChatEventConflict = "none",
): Promise<ChatEventCommandResult | null> {
  const [valueWithSeqId] = await addSeqIdsToEvents(tx, [
    persistedChatEventValues(values),
  ]);
  if (!valueWithSeqId) {
    throw new Error("chat event seq_id was not assigned");
  }

  const query = tx.insert(chatMessages).values(valueWithSeqId);
  const rows =
    conflict === "any"
      ? await query.onConflictDoNothing().returning({
          id: chatMessages.id,
          createdAt: chatMessages.createdAt,
          seqId: chatMessages.seqId,
        })
      : conflict === "id"
        ? await query
            .onConflictDoNothing({ target: chatMessages.id })
            .returning({
              id: chatMessages.id,
              createdAt: chatMessages.createdAt,
              seqId: chatMessages.seqId,
            })
        : conflict === "run-lifecycle"
          ? await query
              .onConflictDoNothing({
                target: chatMessages.runId,
                where: isNotNull(chatMessages.runLifecycleEvent),
              })
              .returning({
                id: chatMessages.id,
                createdAt: chatMessages.createdAt,
                seqId: chatMessages.seqId,
              })
          : await query.returning({
              id: chatMessages.id,
              createdAt: chatMessages.createdAt,
              seqId: chatMessages.seqId,
            });

  return rows[0] ?? null;
}

export async function insertChatEvents(
  tx: ChatEventWriteTransaction,
  values: readonly AppendChatEvent[],
  conflict: InsertChatEventsConflict,
): Promise<readonly ChatEventBatchCommandResult[]> {
  if (values.length === 0) {
    return [];
  }

  const valuesWithSeqIds = await addSeqIdsToEvents(
    tx,
    values.map(persistedChatEventValues),
  );
  const query = tx.insert(chatMessages).values([...valuesWithSeqIds]);
  if (conflict === "any") {
    return await query.onConflictDoNothing().returning({
      id: chatMessages.id,
      createdAt: chatMessages.createdAt,
      seqId: chatMessages.seqId,
      sequenceNumber: chatMessages.sequenceNumber,
    });
  }
  return await query
    .onConflictDoNothing({
      target: [chatMessages.runId, chatMessages.sequenceNumber],
    })
    .returning({
      id: chatMessages.id,
      createdAt: chatMessages.createdAt,
      seqId: chatMessages.seqId,
      sequenceNumber: chatMessages.sequenceNumber,
    });
}

/** Append a replacement event after validating its immutable revoke edge. */
export async function replaceChatEvent(
  tx: ChatEventWriteTransaction,
  eventId: string,
  replacement: NewChatEvent,
): Promise<ChatEventCommandResult | null> {
  const [target] = await tx
    .select({
      chatThreadId: chatMessages.chatThreadId,
      createdAt: chatMessages.createdAt,
      eventType: chatMessages.eventType,
    })
    .from(chatMessages)
    .where(eq(chatMessages.id, eventId))
    .limit(1);
  if (!target) {
    throw new Error("Cannot revoke a missing chat event");
  }
  if (target.chatThreadId !== replacement.chatThreadId) {
    throw new Error("Cannot revoke a chat event from another thread");
  }
  if (replacement.id === eventId) {
    throw new Error("A chat event cannot revoke itself");
  }
  const createdAt =
    replacement.createdAt ??
    new Date(Math.max(nowDate().getTime(), target.createdAt.getTime() + 1));
  if (createdAt <= target.createdAt) {
    throw new Error("A chat event can only revoke an earlier event");
  }
  if (!isValidChatEventRevocation(replacement.eventType, target.eventType)) {
    throw new Error(
      `Invalid chat event revocation: ${replacement.eventType} -> ${target.eventType}`,
    );
  }

  const seqId = await reserveChatEventSeqIds(tx, replacement.chatThreadId, 1);
  const rows = await tx
    .insert(chatMessages)
    .values({
      ...persistedChatEventValues({ ...replacement, createdAt }),
      seqId,
      revokesEventId: eventId,
    })
    .onConflictDoNothing()
    .returning({
      id: chatMessages.id,
      createdAt: chatMessages.createdAt,
      seqId: chatMessages.seqId,
    });
  return rows[0] ?? null;
}

/** Append a payload-free revocation event for an existing chat event. */
export async function revokeChatEvent(
  tx: ChatEventWriteTransaction,
  eventId: string,
  revocation: ControlRevokeEvent | RunDequeuedEvent,
): Promise<ChatEventCommandResult | null> {
  return await replaceChatEvent(tx, eventId, {
    ...revocation,
    content: null,
  });
}
