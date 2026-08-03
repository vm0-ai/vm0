import { randomUUID } from "node:crypto";

import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatMorningBriefContext } from "@vm0/db/schema/chat-morning-brief-context";
import { morningBriefDeliveries } from "@vm0/db/schema/morning-brief";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";
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
