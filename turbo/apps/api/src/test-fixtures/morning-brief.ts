import { randomUUID } from "node:crypto";

import { chatMessages } from "@vm0/db/schema/chat-message";
import { morningBriefDeliveries } from "@vm0/db/schema/morning-brief";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";
import {
  decryptQueuedUserMessageRunParams,
  encryptQueuedUserMessageRunParams,
} from "../signals/services/zero-chat-queued-message.service";
import {
  insertChatEvent,
  replaceChatEvent,
} from "../signals/services/zero-chat-event.service";
import { touchChatThreadLastMessageAt } from "../signals/services/zero-chat-message-shared.service";
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
    .select({ encryptedParams: chatMessages.encryptedParams })
    .from(chatMessages)
    .where(eq(chatMessages.chatThreadId, args.threadId));
  for (const message of messages) {
    const params = await decryptQueuedUserMessageRunParams(
      message.encryptedParams,
      { orgId: args.orgId, userId: args.userId },
    );
    if (params?.morningBriefDelivery?.deliveryId === args.deliveryId) {
      return params;
    }
  }
  return null;
}

/**
 * Replace the opaque callback payload on a queued Morning Brief. Public APIs
 * always create the valid shape, so only a fixture can exercise terminal chat
 * handling when the internal callback rejects persisted payload data.
 */
export async function replaceMorningBriefQueuedCallbackPayloadFixture(args: {
  readonly deliveryId: string;
  readonly threadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly payload: unknown;
}): Promise<void> {
  const messages = await db()
    .select({
      id: chatMessages.id,
      encryptedParams: chatMessages.encryptedParams,
      userMessage: chatMessages.userMessage,
      attachFiles: chatMessages.attachFiles,
      attachFileMetadata: chatMessages.attachFileMetadata,
      generationTemplate: chatMessages.generationTemplate,
      triggerSource: chatMessages.triggerSource,
    })
    .from(chatMessages)
    .where(eq(chatMessages.chatThreadId, args.threadId));
  for (const message of messages) {
    const params = await decryptQueuedUserMessageRunParams(
      message.encryptedParams,
      { orgId: args.orgId, userId: args.userId },
    );
    if (params?.morningBriefDelivery?.deliveryId !== args.deliveryId) {
      continue;
    }
    const encryptedParams = await encryptQueuedUserMessageRunParams(
      {
        ...params,
        morningBriefDelivery: {
          ...params.morningBriefDelivery,
          payload: args.payload,
        },
      },
      { orgId: args.orgId, userId: args.userId },
    );
    if (!message.userMessage) {
      throw new Error("Expected the queued Morning Brief user message");
    }
    const userMessage = message.userMessage;
    const replaced = await db().transaction(async (tx) => {
      return await replaceChatEvent(tx, message.id, {
        chatThreadId: args.threadId,
        eventType: "input.prompt",
        userMessage,
        runId: null,
        encryptedParams,
        attachFiles: message.attachFiles ? [...message.attachFiles] : null,
        attachFileMetadata: message.attachFileMetadata
          ? [...message.attachFileMetadata]
          : null,
        generationTemplate: message.generationTemplate,
        ...(message.triggerSource
          ? { triggerSource: message.triggerSource }
          : {}),
      });
    });
    if (!replaced) {
      throw new Error("Expected the queued Morning Brief callback payload");
    }
    return;
  }
  throw new Error("Expected the queued Morning Brief delivery");
}

export async function readMorningBriefQueuedParamsFixture(args: {
  readonly messageId: string;
  readonly orgId: string;
  readonly userId: string;
}) {
  const [message] = await db()
    .select({ encryptedParams: chatMessages.encryptedParams })
    .from(chatMessages)
    .where(eq(chatMessages.id, args.messageId))
    .limit(1);
  return await decryptQueuedUserMessageRunParams(
    message?.encryptedParams ?? null,
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
  readonly apiStartTime?: number;
}): Promise<string> {
  const messageId = randomUUID();
  const encryptedParams = await encryptQueuedUserMessageRunParams(
    {
      version: 1,
      prompt: args.prompt,
      appendSystemPrompt: args.appendSystemPrompt,
      apiStartTime: args.apiStartTime,
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
