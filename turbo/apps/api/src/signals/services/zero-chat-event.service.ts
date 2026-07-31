/** Typed append-only commands for the canonical ChatEvent stream. */
import { randomUUID } from "node:crypto";

import {
  chatEventRunLifecycle,
  isValidChatEventRevocation,
} from "@vm0/api-contracts/contracts/chat-events";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { chatAutomationContext } from "@vm0/db/schema/chat-automation-context";
import { chatEventInputParams } from "@vm0/db/schema/chat-event-input-params";
import {
  chatEvents,
  type ChatEventGoalSnapshot,
} from "@vm0/db/schema/chat-event";
import { chatFeishuContext } from "@vm0/db/schema/chat-feishu-context";
import { chatGithubContext } from "@vm0/db/schema/chat-github-context";
import { chatGoalContext } from "@vm0/db/schema/chat-goal-context";
import { chatSlackContext } from "@vm0/db/schema/chat-slack-context";
import { chatTeamsContext } from "@vm0/db/schema/chat-teams-context";
import { chatTelegramContext } from "@vm0/db/schema/chat-telegram-context";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { chatEventAssetRefs } from "@vm0/db/schema/run-uploaded-file";
import { eq, isNotNull, sql } from "drizzle-orm";

import type { Db } from "../external/db";
import { nowDate } from "../external/time";

type ChatEventInsert = typeof chatEvents.$inferInsert;
type ChatEventWriteTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

type ChatEventIdentity = Pick<
  ChatEventInsert,
  "id" | "chatThreadId" | "runId" | "runGroupId"
> & {
  readonly createdAt?: Date;
};

type ChatEventDisplayContext =
  | {
      readonly slackContext: {
        readonly messagePermalink: string | null;
        readonly channelId: string;
        readonly messageTs: string;
      };
      readonly feishuContext?: never;
      readonly teamsContext?: never;
      readonly telegramContext?: never;
      readonly githubContext?: never;
    }
  | {
      readonly slackContext?: never;
      readonly feishuContext: {
        readonly chatOpenUrl: string;
      };
      readonly teamsContext?: never;
      readonly telegramContext?: never;
      readonly githubContext?: never;
    }
  | {
      readonly slackContext?: never;
      readonly feishuContext?: never;
      readonly teamsContext: {
        readonly tenantId: string;
        readonly teamId: string | null;
        readonly channelId: string | null;
        readonly conversationId: string;
        readonly conversationType: string | null;
        readonly activityId: string | null;
      };
      readonly telegramContext?: never;
      readonly githubContext?: never;
    }
  | {
      readonly slackContext?: never;
      readonly feishuContext?: never;
      readonly teamsContext?: never;
      readonly telegramContext: {
        readonly chatId: string;
        readonly messageId: string;
        readonly isDm: boolean;
        readonly messageThreadId: number | null;
      };
      readonly githubContext?: never;
    }
  | {
      readonly slackContext?: never;
      readonly feishuContext?: never;
      readonly teamsContext?: never;
      readonly telegramContext?: never;
      readonly githubContext: {
        readonly repo: string;
        readonly subjectNumber: number;
        readonly subjectKind: "issue" | "pull_request";
        readonly triggerCommentId: string | null;
      };
    }
  | {
      readonly slackContext?: never;
      readonly feishuContext?: never;
      readonly teamsContext?: never;
      readonly telegramContext?: never;
      readonly githubContext?: never;
    };

type ChatEventInputPayload = Pick<
  ChatEventInsert,
  "attachFiles" | "generationTemplate"
> & {
  readonly attachFileMetadata?: typeof chatEventInputParams.$inferInsert.attachFileMetadata;
  readonly userMessage: NonNullable<ChatEventInsert["userMessage"]>;
};

type ChatEventOutputSequence = Pick<
  ChatEventInsert,
  "sequenceNumber" | "runEventId"
>;

type InputPromptEvent = ChatEventIdentity &
  ChatEventDisplayContext &
  ChatEventInputPayload & {
    readonly eventType: "input.prompt";
    readonly content?: null;
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

type InputGoalEvent = ChatEventIdentity & {
  readonly eventType: "input.goal";
  readonly content?: null;
  readonly runGroupId: string;
  readonly goalSnapshot: ChatEventGoalSnapshot;
};

type InputRejectedEvent = ChatEventIdentity &
  ChatEventDisplayContext &
  ChatEventInputPayload &
  Pick<ChatEventInsert, "sequenceNumber"> & {
    readonly eventType: "input.rejected";
    readonly content?: null;
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

type BrowserLifecycleEvent = Pick<
  ChatEventIdentity,
  "id" | "chatThreadId" | "createdAt"
> & {
  readonly eventType: "browser.started" | "browser.stopped";
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
  | InputGoalEvent
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
  | ControlInterruptEvent
  | ControlRevokeEvent
  | BrowserLifecycleEvent
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

type ChatEventContextPointer = Pick<
  ChatEventInsert,
  "contextType" | "contextId"
>;

interface StoredChatEventContextPointer {
  readonly contextType: NonNullable<ChatEventInsert["contextType"]> | null;
  readonly contextId: string | null;
}

type NewDisplayContext =
  | {
      readonly type: "slack";
      readonly id: string;
      readonly chatThreadId: string;
      readonly messagePermalink: string | null;
      readonly channelId: string;
      readonly messageTs: string;
    }
  | {
      readonly type: "feishu";
      readonly id: string;
      readonly chatThreadId: string;
      readonly chatOpenUrl: string;
    }
  | {
      readonly type: "teams";
      readonly id: string;
      readonly chatThreadId: string;
      readonly tenantId: string;
      readonly teamId: string | null;
      readonly channelId: string | null;
      readonly conversationId: string;
      readonly conversationType: string | null;
      readonly activityId: string | null;
    }
  | {
      readonly type: "telegram";
      readonly id: string;
      readonly chatThreadId: string;
      readonly chatId: string;
      readonly messageId: string;
      readonly isDm: boolean;
      readonly messageThreadId: number | null;
    }
  | {
      readonly type: "github";
      readonly id: string;
      readonly chatThreadId: string;
      readonly repo: string;
      readonly subjectNumber: number;
      readonly subjectKind: "issue" | "pull_request";
      readonly triggerCommentId: string | null;
    }
  | {
      readonly type: "automation";
      readonly id: string;
      readonly chatThreadId: string;
      readonly automationId: string;
      readonly triggerBrief: string | null;
    }
  | {
      readonly type: "goal";
      readonly id: string;
      readonly chatThreadId: string;
      readonly objectiveBrief: string;
    };

function isPendingInputEvent(values: NewChatEvent): boolean {
  return (
    (values.eventType === "input.prompt" ||
      values.eventType === "input.automation" ||
      values.eventType === "input.goal") &&
    values.runId === null
  );
}

function eventInputParams(values: NewChatEvent):
  | {
      readonly encryptedParams: string;
      readonly attachFileMetadata:
        | typeof chatEventInputParams.$inferInsert.attachFileMetadata
        | undefined;
    }
  | undefined {
  if (
    !isPendingInputEvent(values) ||
    !("encryptedParams" in values) ||
    !values.encryptedParams
  ) {
    return undefined;
  }
  return {
    encryptedParams: values.encryptedParams,
    attachFileMetadata:
      "attachFileMetadata" in values ? values.attachFileMetadata : undefined,
  };
}

async function insertEventInputParams(
  tx: ChatEventWriteTransaction,
  eventId: string,
  values: NewChatEvent,
): Promise<void> {
  const params = eventInputParams(values);
  if (!params) {
    return;
  }
  await tx.insert(chatEventInputParams).values({
    eventId,
    encryptedParams: params.encryptedParams,
    attachFileMetadata: params.attachFileMetadata,
  });
}

function newDisplayContext(
  eventId: string,
  values: NewChatEvent,
): NewDisplayContext | undefined {
  const slackContext =
    "slackContext" in values ? values.slackContext : undefined;
  if (slackContext !== undefined) {
    return {
      type: "slack",
      id: eventId,
      chatThreadId: values.chatThreadId,
      messagePermalink: slackContext.messagePermalink,
      channelId: slackContext.channelId,
      messageTs: slackContext.messageTs,
    };
  }

  const feishuContext =
    "feishuContext" in values ? values.feishuContext : undefined;
  if (feishuContext !== undefined) {
    return {
      type: "feishu",
      id: eventId,
      chatThreadId: values.chatThreadId,
      chatOpenUrl: feishuContext.chatOpenUrl,
    };
  }

  const teamsContext =
    "teamsContext" in values ? values.teamsContext : undefined;
  if (teamsContext !== undefined) {
    return {
      type: "teams",
      id: eventId,
      chatThreadId: values.chatThreadId,
      ...teamsContext,
    };
  }

  const telegramContext =
    "telegramContext" in values ? values.telegramContext : undefined;
  if (telegramContext !== undefined) {
    return {
      type: "telegram",
      id: eventId,
      chatThreadId: values.chatThreadId,
      ...telegramContext,
    };
  }

  const githubContext =
    "githubContext" in values ? values.githubContext : undefined;
  if (githubContext !== undefined) {
    return {
      type: "github",
      id: eventId,
      chatThreadId: values.chatThreadId,
      ...githubContext,
    };
  }

  const automationId =
    "automationId" in values ? values.automationId : undefined;
  if (automationId !== undefined) {
    return {
      type: "automation",
      id: eventId,
      chatThreadId: values.chatThreadId,
      automationId,
      triggerBrief:
        "triggerBrief" in values ? (values.triggerBrief ?? null) : null,
    };
  }

  const goalSnapshot =
    "goalSnapshot" in values ? values.goalSnapshot : undefined;
  if (goalSnapshot !== null && goalSnapshot !== undefined) {
    return {
      type: "goal",
      id: eventId,
      chatThreadId: values.chatThreadId,
      objectiveBrief: goalSnapshot.objectiveBrief,
    };
  }

  return undefined;
}

function displayContextPointer(
  context: NewDisplayContext | undefined,
): ChatEventContextPointer | undefined {
  if (!context) {
    return undefined;
  }
  return {
    contextType: context.type,
    contextId: context.id,
  };
}

function replacementContext(
  target: StoredChatEventContextPointer,
  eventId: string,
  values: NewChatEvent,
): {
  readonly pointer: ChatEventContextPointer | undefined;
  readonly displayContext: NewDisplayContext | undefined;
} {
  if (target.contextType !== null && target.contextId !== null) {
    return {
      pointer: {
        contextType: target.contextType,
        contextId: target.contextId,
      },
      displayContext: undefined,
    };
  }
  const displayContext = newDisplayContext(eventId, values);
  return {
    pointer: displayContextPointer(displayContext),
    displayContext,
  };
}

async function insertDisplayContext(
  tx: ChatEventWriteTransaction,
  context: NewDisplayContext,
  createdAt: Date,
): Promise<void> {
  if (context.type === "slack") {
    await tx.insert(chatSlackContext).values({
      id: context.id,
      chatThreadId: context.chatThreadId,
      messagePermalink: context.messagePermalink,
      channelId: context.channelId,
      messageTs: context.messageTs,
      createdAt,
    });
    return;
  }
  if (context.type === "feishu") {
    await tx.insert(chatFeishuContext).values({
      id: context.id,
      chatThreadId: context.chatThreadId,
      chatOpenUrl: context.chatOpenUrl,
      createdAt,
    });
    return;
  }
  if (context.type === "teams") {
    await tx.insert(chatTeamsContext).values({
      id: context.id,
      chatThreadId: context.chatThreadId,
      tenantId: context.tenantId,
      teamId: context.teamId,
      channelId: context.channelId,
      conversationId: context.conversationId,
      conversationType: context.conversationType,
      activityId: context.activityId,
      createdAt,
    });
    return;
  }
  if (context.type === "telegram") {
    await tx.insert(chatTelegramContext).values({
      id: context.id,
      chatThreadId: context.chatThreadId,
      chatId: context.chatId,
      messageId: context.messageId,
      isDm: context.isDm,
      messageThreadId: context.messageThreadId,
      createdAt,
    });
    return;
  }
  if (context.type === "github") {
    await tx.insert(chatGithubContext).values({
      id: context.id,
      chatThreadId: context.chatThreadId,
      repo: context.repo,
      subjectNumber: context.subjectNumber,
      subjectKind: context.subjectKind,
      triggerCommentId: context.triggerCommentId,
      createdAt,
    });
    return;
  }
  if (context.type === "automation") {
    await tx.insert(chatAutomationContext).values({
      id: context.id,
      chatThreadId: context.chatThreadId,
      automationId: context.automationId,
      triggerBrief: context.triggerBrief,
      createdAt,
    });
    return;
  }
  await tx.insert(chatGoalContext).values({
    id: context.id,
    chatThreadId: context.chatThreadId,
    objectiveBrief: context.objectiveBrief,
    createdAt,
  });
}

function persistedChatEventValues(
  values: NewChatEvent,
  overrides?: Partial<
    Pick<ChatEventInsert, "id" | "contextType" | "contextId">
  >,
): PersistedChatEvent {
  const runLifecycleEvent = chatEventRunLifecycle(values.eventType);
  const { goalSnapshot: _goalSnapshot, ...persistedValues } = {
    goalSnapshot: undefined,
    ...values,
  };
  return {
    ...persistedValues,
    ...overrides,
    ...(values.eventType === "input.prompt" ||
    values.eventType === "input.rejected" ||
    values.eventType === "input.automation" ||
    values.eventType === "input.goal"
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
      lastChatEventSeqId: sql`${chatThreads.lastChatEventSeqId} + ${count}`,
    })
    .where(eq(chatThreads.id, chatThreadId))
    .returning({ lastSeqId: chatThreads.lastChatEventSeqId });
  if (!thread) {
    throw new Error(`Chat thread ${chatThreadId} not found`);
  }
  return thread.lastSeqId - count + 1;
}

async function releaseChatEventSeqId(
  tx: ChatEventWriteTransaction,
  chatThreadId: string,
): Promise<void> {
  const [thread] = await tx
    .update(chatThreads)
    .set({
      lastChatEventSeqId: sql`${chatThreads.lastChatEventSeqId} - 1`,
    })
    .where(eq(chatThreads.id, chatThreadId))
    .returning({ id: chatThreads.id });
  if (!thread) {
    throw new Error(`Chat thread ${chatThreadId} not found`);
  }
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
  const eventId = values.id ?? randomUUID();
  const displayContext = newDisplayContext(eventId, values);
  const [valueWithSeqId] = await addSeqIdsToEvents(tx, [
    persistedChatEventValues(values, {
      id: eventId,
      ...displayContextPointer(displayContext),
    }),
  ]);
  if (!valueWithSeqId) {
    throw new Error("chat event seq_id was not assigned");
  }

  const query = tx.insert(chatEvents).values(valueWithSeqId);
  const rows =
    conflict === "any"
      ? await query.onConflictDoNothing().returning({
          id: chatEvents.id,
          createdAt: chatEvents.createdAt,
          seqId: chatEvents.seqId,
        })
      : conflict === "id"
        ? await query.onConflictDoNothing({ target: chatEvents.id }).returning({
            id: chatEvents.id,
            createdAt: chatEvents.createdAt,
            seqId: chatEvents.seqId,
          })
        : conflict === "run-lifecycle"
          ? await query
              .onConflictDoNothing({
                target: chatEvents.runId,
                where: isNotNull(chatEvents.runLifecycleEvent),
              })
              .returning({
                id: chatEvents.id,
                createdAt: chatEvents.createdAt,
                seqId: chatEvents.seqId,
              })
          : await query.returning({
              id: chatEvents.id,
              createdAt: chatEvents.createdAt,
              seqId: chatEvents.seqId,
            });

  if (rows.length === 0) {
    // A rejected idempotent write is not part of the canonical stream, so it
    // must not consume the thread's next cursor.
    await releaseChatEventSeqId(tx, values.chatThreadId);
  } else {
    const inserted = rows[0];
    if (!inserted) {
      throw new Error("Inserted chat event result is missing");
    }
    if (displayContext) {
      await insertDisplayContext(tx, displayContext, inserted.createdAt);
    }
    await insertEventInputParams(tx, inserted.id, values);
  }
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
    values.map((value) => {
      return persistedChatEventValues(value);
    }),
  );
  const query = tx.insert(chatEvents).values([...valuesWithSeqIds]);
  if (conflict === "any") {
    return await query.onConflictDoNothing().returning({
      id: chatEvents.id,
      createdAt: chatEvents.createdAt,
      seqId: chatEvents.seqId,
      sequenceNumber: chatEvents.sequenceNumber,
    });
  }
  return await query
    .onConflictDoNothing({
      target: [chatEvents.runId, chatEvents.sequenceNumber],
    })
    .returning({
      id: chatEvents.id,
      createdAt: chatEvents.createdAt,
      seqId: chatEvents.seqId,
      sequenceNumber: chatEvents.sequenceNumber,
    });
}

/** Append a replacement event after validating its immutable revoke edge. */
export async function replaceChatEvent(
  tx: ChatEventWriteTransaction,
  eventId: string,
  replacement: NewChatEvent,
  options?: { readonly preserveAssetRefs?: boolean },
): Promise<ChatEventCommandResult | null> {
  const [target] = await tx
    .select({
      chatThreadId: chatEvents.chatThreadId,
      createdAt: chatEvents.createdAt,
      eventType: chatEvents.eventType,
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
      encryptedParams: chatEventInputParams.encryptedParams,
      attachFileMetadata: chatEventInputParams.attachFileMetadata,
    })
    .from(chatEvents)
    .leftJoin(
      chatEventInputParams,
      eq(chatEventInputParams.eventId, chatEvents.id),
    )
    .where(eq(chatEvents.id, eventId))
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

  const replacementWithParams =
    isPendingInputEvent(replacement) && target.encryptedParams
      ? {
          ...replacement,
          encryptedParams:
            "encryptedParams" in replacement && replacement.encryptedParams
              ? replacement.encryptedParams
              : target.encryptedParams,
          attachFileMetadata:
            "attachFileMetadata" in replacement
              ? replacement.attachFileMetadata
              : target.attachFileMetadata,
        }
      : replacement;
  const replacementId = replacement.id ?? randomUUID();
  const { pointer: contextPointer, displayContext } = replacementContext(
    target,
    replacementId,
    replacementWithParams,
  );
  const seqId = await reserveChatEventSeqIds(tx, replacement.chatThreadId, 1);
  const rows = await tx
    .insert(chatEvents)
    .values({
      ...persistedChatEventValues(
        { ...replacementWithParams, createdAt },
        {
          id: replacementId,
          ...contextPointer,
        },
      ),
      seqId,
      revokesEventId: eventId,
    })
    .onConflictDoNothing()
    .returning({
      id: chatEvents.id,
      createdAt: chatEvents.createdAt,
      seqId: chatEvents.seqId,
    });
  const inserted = rows[0];
  if (!inserted) {
    return null;
  }

  if (displayContext) {
    await insertDisplayContext(tx, displayContext, inserted.createdAt);
  }
  await insertEventInputParams(tx, inserted.id, replacementWithParams);
  if (options?.preserveAssetRefs !== false) {
    const assetRefs = await tx
      .select({
        assetId: chatEventAssetRefs.assetId,
        position: chatEventAssetRefs.position,
      })
      .from(chatEventAssetRefs)
      .where(eq(chatEventAssetRefs.chatEventId, eventId));
    if (assetRefs.length > 0) {
      await tx
        .insert(chatEventAssetRefs)
        .values(
          assetRefs.map((assetRef) => {
            return {
              chatEventId: inserted.id,
              assetId: assetRef.assetId,
              position: assetRef.position,
            };
          }),
        )
        .onConflictDoNothing();
    }
  }
  await tx
    .delete(chatEventInputParams)
    .where(eq(chatEventInputParams.eventId, eventId));
  return inserted;
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
