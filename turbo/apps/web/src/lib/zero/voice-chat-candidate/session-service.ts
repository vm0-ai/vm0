import { and, desc, eq } from "drizzle-orm";
import { featureCandidateVoiceChatSessions } from "../../../db/schema/voice-chat-candidate";

type SessionRow = typeof featureCandidateVoiceChatSessions.$inferSelect;

/**
 * Get-or-create: return the most recent session for this (userId, agentId),
 * or create a new one. Voice-chat-candidate sessions are stateless
 * long-lived containers — there is no "active / ended / timeout" lifecycle,
 * so every re-entry simply resumes whatever was there before.
 */
export async function createVoiceChatCandidateSession(params: {
  orgId: string;
  userId: string;
  agentId: string;
}): Promise<SessionRow> {
  const db = globalThis.services.db;
  const [existing] = await db
    .select()
    .from(featureCandidateVoiceChatSessions)
    .where(
      and(
        eq(featureCandidateVoiceChatSessions.userId, params.userId),
        eq(featureCandidateVoiceChatSessions.agentId, params.agentId),
      ),
    )
    .orderBy(desc(featureCandidateVoiceChatSessions.createdAt))
    .limit(1);
  if (existing) {
    return existing;
  }

  const [session] = await db
    .insert(featureCandidateVoiceChatSessions)
    .values({
      orgId: params.orgId,
      userId: params.userId,
      agentId: params.agentId,
    })
    .returning();
  if (!session) {
    throw new Error("Failed to insert voice-chat-candidate session");
  }
  return session;
}

export async function getVoiceChatCandidateSession(
  id: string,
): Promise<SessionRow | null> {
  const db = globalThis.services.db;
  const [session] = await db
    .select()
    .from(featureCandidateVoiceChatSessions)
    .where(eq(featureCandidateVoiceChatSessions.id, id))
    .limit(1);
  return session ?? null;
}

export async function listVoiceChatCandidateSessions(params: {
  orgId: string;
  userId: string;
  limit?: number;
}): Promise<SessionRow[]> {
  const db = globalThis.services.db;
  return db
    .select()
    .from(featureCandidateVoiceChatSessions)
    .where(
      and(
        eq(featureCandidateVoiceChatSessions.orgId, params.orgId),
        eq(featureCandidateVoiceChatSessions.userId, params.userId),
      ),
    )
    .orderBy(desc(featureCandidateVoiceChatSessions.createdAt))
    .limit(params.limit ?? 50);
}
