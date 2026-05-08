import { and, desc, eq } from "drizzle-orm";
import { voiceChatSessions } from "@vm0/db/schema/voice-chat";

export type VoiceChatSessionRow = typeof voiceChatSessions.$inferSelect;
type SessionRow = VoiceChatSessionRow;

/**
 * Get-or-create: return the most recent session for this (userId, agentId),
 * or create a new one. Voice-chat sessions are stateless
 * long-lived containers — there is no "active / ended / timeout" lifecycle,
 * so every re-entry simply resumes whatever was there before.
 */
export async function createVoiceChatSession(params: {
  orgId: string;
  userId: string;
  agentId: string;
}): Promise<SessionRow> {
  const db = globalThis.services.db;
  const [existing] = await db
    .select()
    .from(voiceChatSessions)
    .where(
      and(
        eq(voiceChatSessions.userId, params.userId),
        eq(voiceChatSessions.agentId, params.agentId),
      ),
    )
    .orderBy(desc(voiceChatSessions.createdAt))
    .limit(1);
  if (existing) {
    return existing;
  }

  const [session] = await db
    .insert(voiceChatSessions)
    .values({
      orgId: params.orgId,
      userId: params.userId,
      agentId: params.agentId,
    })
    .returning();
  if (!session) {
    throw new Error("Failed to insert voice-chat session");
  }
  return session;
}

export async function getVoiceChatSession(
  id: string,
): Promise<SessionRow | null> {
  const db = globalThis.services.db;
  const [session] = await db
    .select()
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, id))
    .limit(1);
  return session ?? null;
}

export async function listVoiceChatSessions(params: {
  orgId: string;
  userId: string;
  limit?: number;
}): Promise<SessionRow[]> {
  const db = globalThis.services.db;
  return db
    .select()
    .from(voiceChatSessions)
    .where(
      and(
        eq(voiceChatSessions.orgId, params.orgId),
        eq(voiceChatSessions.userId, params.userId),
      ),
    )
    .orderBy(desc(voiceChatSessions.createdAt))
    .limit(params.limit ?? 50);
}
