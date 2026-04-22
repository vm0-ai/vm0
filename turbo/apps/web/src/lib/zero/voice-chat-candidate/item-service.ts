import { and, asc, desc, eq, gt } from "drizzle-orm";
import {
  featureCandidateVoiceChatItems,
  featureCandidateVoiceChatSessions,
} from "../../../db/schema/voice-chat-candidate";
import { notFound } from "../../shared/errors";

type ItemRow = typeof featureCandidateVoiceChatItems.$inferSelect;
type ItemRole = "user" | "assistant" | "task_result" | "system_note";

async function assertSessionExists(sessionId: string): Promise<void> {
  const db = globalThis.services.db;
  const [session] = await db
    .select({ id: featureCandidateVoiceChatSessions.id })
    .from(featureCandidateVoiceChatSessions)
    .where(eq(featureCandidateVoiceChatSessions.id, sessionId))
    .limit(1);
  if (!session) {
    throw notFound("Voice-chat-candidate session not found");
  }
}

export async function appendVoiceChatCandidateItem(params: {
  sessionId: string;
  role: ItemRole;
  content: string | null;
  taskId?: string | null;
  realtimeItemId?: string | null;
}): Promise<ItemRow | null> {
  const db = globalThis.services.db;
  await assertSessionExists(params.sessionId);

  const [inserted] = await db
    .insert(featureCandidateVoiceChatItems)
    .values({
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      taskId: params.taskId ?? null,
      realtimeItemId: params.realtimeItemId ?? null,
    })
    .onConflictDoNothing({
      target: [
        featureCandidateVoiceChatItems.sessionId,
        featureCandidateVoiceChatItems.realtimeItemId,
      ],
    })
    .returning();

  return inserted ?? null;
}

export async function readVoiceChatCandidateItems(
  sessionId: string,
  afterSeq?: number,
): Promise<ItemRow[]> {
  const db = globalThis.services.db;
  const baseCondition = eq(featureCandidateVoiceChatItems.sessionId, sessionId);
  const condition =
    afterSeq !== undefined
      ? and(baseCondition, gt(featureCandidateVoiceChatItems.seq, afterSeq))
      : baseCondition;
  return db
    .select()
    .from(featureCandidateVoiceChatItems)
    .where(condition)
    .orderBy(asc(featureCandidateVoiceChatItems.seq));
}

/**
 * Role-scoped transcript read with seq cursor.
 *
 * - `sinceSeq` absent → baseline mode: returns at most the single latest row
 *   of that role in the session. Caller uses it purely to seed its cursor;
 *   the item is not meant to be displayed. This is what makes re-entry
 *   suppress prior utterances in the UI.
 * - `sinceSeq` provided → increment mode: returns every row of that role
 *   with seq > sinceSeq, ordered ASC.
 */
export async function listTranscriptByRole(
  sessionId: string,
  role: ItemRole,
  sinceSeq: number | undefined,
): Promise<ItemRow[]> {
  const db = globalThis.services.db;
  const baseCondition = and(
    eq(featureCandidateVoiceChatItems.sessionId, sessionId),
    eq(featureCandidateVoiceChatItems.role, role),
  );

  if (sinceSeq === undefined) {
    return db
      .select()
      .from(featureCandidateVoiceChatItems)
      .where(baseCondition)
      .orderBy(desc(featureCandidateVoiceChatItems.seq))
      .limit(1);
  }

  return db
    .select()
    .from(featureCandidateVoiceChatItems)
    .where(and(baseCondition, gt(featureCandidateVoiceChatItems.seq, sinceSeq)))
    .orderBy(asc(featureCandidateVoiceChatItems.seq));
}
