import { randomUUID } from "node:crypto";

import { chatMessages } from "@vm0/db/schema/chat-message";
import { morningBriefDeliveries } from "@vm0/db/schema/morning-brief";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";
import {
  decryptQueuedUserMessageRunParams,
  encryptQueuedUserMessageRunParams,
} from "../signals/services/zero-chat-queued-message.service";
import { insertChatEvent } from "../signals/services/zero-chat-event.service";
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
 * Appends the production automation-pause control event to a dedicated brief
 * thread. The workflow queue API intentionally has no resource for this
 * non-automation thread, so the acceptance test uses the event writer.
 */
export async function pauseMorningBriefAutomationIntakeFixture(
  threadId: string,
): Promise<void> {
  await db().transaction(async (tx) => {
    await insertChatEvent(tx, {
      chatThreadId: threadId,
      eventType: "queue.automation_paused",
      runId: null,
      pauseReason: "Morning Brief queue acceptance test",
    });
  });
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
