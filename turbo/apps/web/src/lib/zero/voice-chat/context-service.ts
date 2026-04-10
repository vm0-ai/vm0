import { eq, and, gt, asc } from "drizzle-orm";
import {
  voiceChatEvents,
  voiceChatSessions,
} from "../../../db/schema/voice-chat";

export async function readEvents(sessionId: string, afterSeq?: number) {
  const conditions = [eq(voiceChatEvents.sessionId, sessionId)];
  if (afterSeq !== undefined) {
    conditions.push(gt(voiceChatEvents.seq, afterSeq));
  }

  return globalThis.services.db
    .select({
      id: voiceChatEvents.id,
      seq: voiceChatEvents.seq,
      source: voiceChatEvents.source,
      type: voiceChatEvents.type,
      content: voiceChatEvents.content,
      createdAt: voiceChatEvents.createdAt,
    })
    .from(voiceChatEvents)
    .where(and(...conditions))
    .orderBy(asc(voiceChatEvents.seq));
}

export async function appendEvent(
  sessionId: string,
  source: string,
  type: string,
  content?: string,
) {
  const [session] = await globalThis.services.db
    .select({ status: voiceChatSessions.status })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, sessionId))
    .limit(1);

  if (!session) {
    throw Object.assign(new Error("Session not found"), { code: "NOT_FOUND" });
  }
  if (session.status !== "active" && session.status !== "preparing") {
    throw Object.assign(new Error("Session is not active"), {
      code: "BAD_REQUEST",
    });
  }

  const [event] = await globalThis.services.db
    .insert(voiceChatEvents)
    .values({ sessionId, source, type, content: content ?? null })
    .returning({
      id: voiceChatEvents.id,
      seq: voiceChatEvents.seq,
      source: voiceChatEvents.source,
      type: voiceChatEvents.type,
      content: voiceChatEvents.content,
      createdAt: voiceChatEvents.createdAt,
    });

  return event!;
}
