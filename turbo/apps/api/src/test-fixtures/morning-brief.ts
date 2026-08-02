import { randomUUID } from "node:crypto";

import { chatEventInputParams } from "@vm0/db/schema/chat-event-input-params";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatMorningBriefContext } from "@vm0/db/schema/chat-morning-brief-context";
import { morningBriefDeliveries } from "@vm0/db/schema/morning-brief";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";
import {
  decryptQueuedUserMessageRunParams,
  encryptQueuedUserMessageRunParams,
} from "../signals/services/zero-chat-queued-event.service";
import { insertChatEvent } from "../signals/services/zero-chat-event.service";
import { touchChatThreadLastMessageAt } from "../signals/services/zero-chat-event-shared.service";
import { createUserMessageDocument } from "../signals/services/zero-chat-user-message.service";

export async function readMorningBriefDeliveryFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly briefDate: string;
}) {
  const [delivery] = await db()
    .select({
      id: morningBriefDeliveries.id,
      status: morningBriefDeliveries.status,
      runId: morningBriefDeliveries.runId,
      inputKey: morningBriefDeliveries.inputKey,
      outputKey: morningBriefDeliveries.outputKey,
      error: morningBriefDeliveries.error,
    })
    .from(morningBriefDeliveries)
    .where(
      and(
        eq(morningBriefDeliveries.orgId, args.orgId),
        eq(morningBriefDeliveries.userId, args.userId),
        eq(morningBriefDeliveries.briefDate, args.briefDate),
      ),
    )
    .limit(1);
  return delivery ?? null;
}

export async function readMorningBriefQueuedParamsForDeliveryFixture(args: {
  readonly deliveryId: string;
  readonly threadId: string;
  readonly orgId: string;
  readonly userId: string;
}) {
  const messages = await db()
    .select({
      deliveryId: chatMorningBriefContext.deliveryId,
      encryptedParams: chatEventInputParams.encryptedParams,
    })
    .from(chatEvents)
    .leftJoin(
      chatMorningBriefContext,
      and(
        eq(chatMorningBriefContext.id, chatEvents.contextId),
        eq(chatMorningBriefContext.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .leftJoin(
      chatEventInputParams,
      eq(chatEventInputParams.eventId, chatEvents.id),
    )
    .where(eq(chatEvents.chatThreadId, args.threadId));
  for (const message of messages) {
    if (message.deliveryId !== args.deliveryId) {
      continue;
    }
    const params = await decryptQueuedUserMessageRunParams(
      message.encryptedParams,
      { orgId: args.orgId, userId: args.userId },
    );
    return params;
  }
  return null;
}

export async function setMorningBriefTriggeredAtFixture(args: {
  readonly eventId: string;
  readonly triggeredAt: Date;
}): Promise<void> {
  const updated = await db()
    .update(chatMorningBriefContext)
    .set({ triggeredAt: args.triggeredAt })
    .where(eq(chatMorningBriefContext.id, args.eventId))
    .returning({ id: chatMorningBriefContext.id });
  if (updated.length !== 1) {
    throw new Error("Expected one queued Morning Brief context");
  }
}

export async function readMorningBriefQueuedParamsFixture(args: {
  readonly messageId: string;
  readonly orgId: string;
  readonly userId: string;
}) {
  const [event] = await db()
    .select({
      encryptedParams: chatEventInputParams.encryptedParams,
    })
    .from(chatEvents)
    .leftJoin(
      chatEventInputParams,
      eq(chatEventInputParams.eventId, chatEvents.id),
    )
    .where(eq(chatEvents.id, args.messageId))
    .limit(1);
  return await decryptQueuedUserMessageRunParams(
    event?.encryptedParams ?? null,
    { orgId: args.orgId, userId: args.userId },
  );
}

/**
 * Appends a normal web user message without invoking a drain. Product sends
 * persist this same event before draining, but cannot pause at that boundary.
 */
export async function insertQueuedWebUserMessageFixture(args: {
  readonly threadId: string;
  readonly content: string;
  readonly createdAt: Date;
}): Promise<string> {
  const messageId = randomUUID();
  await db().transaction(async (tx) => {
    const inserted = await insertChatEvent(tx, {
      id: messageId,
      chatThreadId: args.threadId,
      eventType: "input.prompt",
      userMessage: createUserMessageDocument({ text: args.content }),
      runId: null,
      triggerSource: "web",
      createdAt: args.createdAt,
    });
    if (!inserted) {
      throw new Error("Expected the queued web user message fixture");
    }
    await touchChatThreadLastMessageAt(
      tx,
      args.threadId,
      inserted.createdAt,
      inserted.id,
    );
  });
  return messageId;
}

/**
 * Inserts the pre-Morning-Brief-extension queued params shape. No product API
 * can create an integration queue item with a historical encrypted payload.
 */
export async function insertOldFormatQueuedUserMessageFixture(args: {
  readonly threadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly content: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly createdAt?: Date;
}): Promise<string> {
  const messageId = randomUUID();
  const encryptedParams = await encryptQueuedUserMessageRunParams(
    {
      version: 1,
      prompt: args.prompt,
      appendSystemPrompt: args.appendSystemPrompt,
    },
    { orgId: args.orgId, userId: args.userId },
  );
  await db().transaction(async (tx) => {
    const inserted = await insertChatEvent(tx, {
      id: messageId,
      chatThreadId: args.threadId,
      eventType: "input.prompt",
      userMessage: createUserMessageDocument({ text: args.content }),
      runId: null,
      triggerSource: "workflow-schedule",
      encryptedParams,
      ...(args.createdAt ? { createdAt: args.createdAt } : {}),
    });
    if (!inserted) {
      throw new Error("Expected the old-format queued message fixture");
    }
    await touchChatThreadLastMessageAt(
      tx,
      args.threadId,
      inserted.createdAt,
      inserted.id,
    );
  });
  return messageId;
}
