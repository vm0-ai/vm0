import { randomUUID } from "node:crypto";

import { agentComposes } from "@okouai/db/schema/agent-compose";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  chatEventSearchDocs,
  chatEventSearchMessages,
  chatEventSearchMessageWatermarks,
  chatEventSearchWatermarks,
} from "@okouai/db/schema/chat-event-search";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../lib/db";
import {
  insertChatEvent,
  replaceChatEvent,
} from "../signals/services/zero-chat-event.service";
import { createUserMessageDocument } from "../signals/services/zero-chat-user-message.service";

interface ChatEventSearchProjectionFixture {
  readonly lastChatEventSeqId: number;
  readonly legacyIndexedSeqId: number | null;
  readonly durableIndexedSeqId: number | null;
  readonly legacyDocs: readonly {
    readonly eventId: string;
    readonly role: "user" | "assistant";
    readonly text: string;
  }[];
  readonly durableMessages: readonly {
    readonly seqId: number;
    readonly runId: string | null;
    readonly role: "user" | "assistant";
    readonly text: string;
  }[];
}

export async function readChatEventSearchProjectionFixture(
  chatThreadId: string,
): Promise<ChatEventSearchProjectionFixture> {
  const [thread] = await db()
    .select({ lastChatEventSeqId: chatThreads.lastChatEventSeqId })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  if (!thread) {
    throw new Error("Expected chat search projection fixture thread");
  }
  const [legacyWatermark] = await db()
    .select({ indexedSeqId: chatEventSearchWatermarks.indexedSeqId })
    .from(chatEventSearchWatermarks)
    .where(eq(chatEventSearchWatermarks.chatThreadId, chatThreadId))
    .limit(1);
  const [durableWatermark] = await db()
    .select({ indexedSeqId: chatEventSearchMessageWatermarks.indexedSeqId })
    .from(chatEventSearchMessageWatermarks)
    .where(eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreadId))
    .limit(1);
  const legacyDocs = await db()
    .select({
      eventId: chatEventSearchDocs.eventId,
      role: chatEventSearchDocs.role,
      text: chatEventSearchDocs.text,
    })
    .from(chatEventSearchDocs)
    .where(eq(chatEventSearchDocs.chatThreadId, chatThreadId))
    .orderBy(asc(chatEventSearchDocs.createdAt));
  const durableMessages = await db()
    .select({
      seqId: chatEventSearchMessages.seqId,
      runId: chatEventSearchMessages.runId,
      role: chatEventSearchMessages.role,
      text: chatEventSearchMessages.text,
    })
    .from(chatEventSearchMessages)
    .where(eq(chatEventSearchMessages.chatThreadId, chatThreadId))
    .orderBy(asc(chatEventSearchMessages.seqId));
  return {
    lastChatEventSeqId: thread.lastChatEventSeqId,
    legacyIndexedSeqId: legacyWatermark?.indexedSeqId ?? null,
    durableIndexedSeqId: durableWatermark?.indexedSeqId ?? null,
    legacyDocs,
    durableMessages,
  };
}

/** Recreates the rollout state where only the established projection exists. */
export async function resetDurableChatEventSearchProjectionFixture(
  chatThreadId: string,
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx
      .delete(chatEventSearchMessages)
      .where(eq(chatEventSearchMessages.chatThreadId, chatThreadId));
    await tx
      .delete(chatEventSearchMessageWatermarks)
      .where(eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreadId));
  });
}

export async function insertChatSearchProjectionCoverageFixture(args: {
  readonly chatThreadId: string;
  readonly promptText: string;
  readonly assistantText: string;
  readonly errorText: string;
  readonly terminalText: string;
}): Promise<{
  readonly prompt: { readonly id: string; readonly seqId: number };
  readonly assistant: { readonly id: string; readonly seqId: number };
  readonly assistantRunId: string;
}> {
  const assistantRunId = randomUUID();
  const messages = await db().transaction(async (tx) => {
    const prompt = await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "input.prompt",
      contextType: "web",
      userMessage: createUserMessageDocument({ text: args.promptText }),
      runId: null,
    });
    const assistant = await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "output.message",
      content: args.assistantText,
      runId: assistantRunId,
    });
    if (!prompt || !assistant) {
      throw new Error("Expected chat search coverage messages");
    }
    await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "output.message",
      content: "   ",
      runId: randomUUID(),
    });
    await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "output.error",
      content: args.errorText,
      error: args.errorText,
      runId: randomUUID(),
    });
    await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "run.completed",
      content: args.terminalText,
      runId: randomUUID(),
    });
    return { prompt, assistant };
  });
  return { ...messages, assistantRunId };
}

/**
 * Simulates retention after the durable projection has caught up. Product APIs
 * cannot delete append-only source events, so the fixture removes only rows
 * owned by the test's unique threads while preserving both search projections.
 */
export async function removeChatSearchSourceEventsFixture(
  chatThreadIds: readonly string[],
): Promise<number> {
  const removed = await db().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    return await tx
      .delete(chatEvents)
      .where(inArray(chatEvents.chatThreadId, [...chatThreadIds]))
      .returning({ id: chatEvents.id });
  });
  return removed.length;
}

/**
 * Changes source-thread ownership and agent metadata after projection so a
 * reader test can prove those fields are not reloaded from chat_threads.
 */
export async function updateChatSearchSourceThreadFixture(args: {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly agentComposeId: string;
}): Promise<void> {
  const updated = await db()
    .update(chatThreads)
    .set({
      userId: args.userId,
      agentComposeId: args.agentComposeId,
    })
    .where(eq(chatThreads.id, args.chatThreadId))
    .returning({ id: chatThreads.id });
  if (updated.length !== 1) {
    throw new Error("Expected one chat search source thread to update");
  }
}

export async function renameChatSearchAgentComposeFixture(args: {
  readonly agentComposeId: string;
  readonly name: string;
}): Promise<void> {
  const updated = await db()
    .update(agentComposes)
    .set({ name: args.name })
    .where(eq(agentComposes.id, args.agentComposeId))
    .returning({ id: agentComposes.id });
  if (updated.length !== 1) {
    throw new Error("Expected one chat search agent compose to rename");
  }
}

export async function insertSearchablePromptFixture(args: {
  readonly chatThreadId: string;
  readonly text: string;
}): Promise<{ readonly id: string; readonly seqId: number }> {
  const inserted = await db().transaction(async (tx) => {
    return await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "input.prompt",
      contextType: "web",
      userMessage: createUserMessageDocument({ text: args.text }),
      runId: null,
    });
  });
  if (!inserted) {
    throw new Error("Expected searchable prompt fixture event");
  }
  return inserted;
}

export async function rejectSearchablePromptFixture(args: {
  readonly chatThreadId: string;
  readonly eventId: string;
  readonly text: string;
}): Promise<{ readonly id: string; readonly seqId: number }> {
  const inserted = await db().transaction(async (tx) => {
    return await replaceChatEvent(tx, args.eventId, {
      chatThreadId: args.chatThreadId,
      eventType: "input.rejected",
      userMessage: createUserMessageDocument({ text: args.text }),
      runId: null,
      error: "Rejected by the chat search projection fixture",
    });
  });
  if (!inserted) {
    throw new Error("Expected rejected searchable prompt fixture event");
  }
  return inserted;
}
