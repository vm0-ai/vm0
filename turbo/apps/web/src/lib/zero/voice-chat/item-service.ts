import { and, asc, eq, gt } from "drizzle-orm";
import { voiceChatItems, voiceChatSessions } from "@vm0/db/schema/voice-chat";
import { notFound } from "../../shared/errors";

type ItemRow = typeof voiceChatItems.$inferSelect;
type ItemRole = "user" | "assistant" | "task_result" | "system_note";

async function assertSessionExists(sessionId: string): Promise<void> {
  const db = globalThis.services.db;
  const [session] = await db
    .select({ id: voiceChatSessions.id })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, sessionId))
    .limit(1);
  if (!session) {
    throw notFound("Voice-chat session not found");
  }
}

export async function appendVoiceChatItem(params: {
  sessionId: string;
  role: ItemRole;
  content: string | null;
  taskId?: string | null;
  realtimeItemId?: string | null;
}): Promise<ItemRow | null> {
  const db = globalThis.services.db;
  await assertSessionExists(params.sessionId);

  const [inserted] = await db
    .insert(voiceChatItems)
    .values({
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      taskId: params.taskId ?? null,
      realtimeItemId: params.realtimeItemId ?? null,
    })
    .onConflictDoNothing({
      target: [voiceChatItems.sessionId, voiceChatItems.realtimeItemId],
    })
    .returning();

  return inserted ?? null;
}

export async function readVoiceChatItems(
  sessionId: string,
  afterSeq?: number,
): Promise<ItemRow[]> {
  const db = globalThis.services.db;
  const baseCondition = eq(voiceChatItems.sessionId, sessionId);
  const condition =
    afterSeq !== undefined
      ? and(baseCondition, gt(voiceChatItems.seq, afterSeq))
      : baseCondition;
  return db
    .select()
    .from(voiceChatItems)
    .where(condition)
    .orderBy(asc(voiceChatItems.seq));
}
