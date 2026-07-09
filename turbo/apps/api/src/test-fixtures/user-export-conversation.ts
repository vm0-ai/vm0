import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { db } from "../lib/db";

interface UserExportConversationSeed {
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
}

/**
 * Seed a chat thread carrying the full role/content matrix the user-export
 * conversation filter must handle: exported user/assistant text rows plus a
 * content-less assistant error row and a system row that must be excluded
 * from the export ZIP.
 *
 * The product chat API only writes user messages directly; assistant error
 * rows and system rows are produced by agent run callbacks whose `created_at`
 * comes from the database clock, so the export-shape test cannot construct
 * these rows (with the deterministic timestamps it asserts on) through
 * product sends.
 */
export async function seedUserExportConversation(
  seed: UserExportConversationSeed,
): Promise<void> {
  const database = db();
  const createdAt = new Date("2026-05-12T05:01:00.000Z");

  await database.insert(chatThreads).values({
    id: seed.threadId,
    userId: seed.userId,
    agentComposeId: seed.agentId,
    title: "BDD export thread",
    lastMessageAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  });

  await database.insert(chatMessages).values([
    {
      chatThreadId: seed.threadId,
      role: "user",
      content: "exported user text",
      createdAt: new Date("2026-05-12T05:02:00.000Z"),
    },
    {
      chatThreadId: seed.threadId,
      role: "assistant",
      content: "exported assistant text",
      createdAt: new Date("2026-05-12T05:03:00.000Z"),
    },
    {
      chatThreadId: seed.threadId,
      role: "assistant",
      content: null,
      error: "hidden assistant error",
      createdAt: new Date("2026-05-12T05:04:00.000Z"),
    },
    {
      chatThreadId: seed.threadId,
      role: "system",
      content: "hidden system text",
      createdAt: new Date("2026-05-12T05:05:00.000Z"),
    },
  ]);
}
