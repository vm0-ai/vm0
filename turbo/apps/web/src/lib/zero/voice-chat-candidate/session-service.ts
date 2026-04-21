import { and, desc, eq } from "drizzle-orm";
import { featureCandidateVoiceChatSessions } from "../../../db/schema/voice-chat-candidate";
import { cancelSessionPendingRuns } from "./task-service";
import { notFound } from "../../shared/errors";

type SessionRow = typeof featureCandidateVoiceChatSessions.$inferSelect;

export async function createVoiceChatCandidateSession(params: {
  orgId: string;
  userId: string;
  agentId: string;
}): Promise<SessionRow> {
  const db = globalThis.services.db;
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

export async function heartbeatVoiceChatCandidateSession(
  id: string,
): Promise<void> {
  const db = globalThis.services.db;
  await db
    .update(featureCandidateVoiceChatSessions)
    .set({ lastHeartbeatAt: new Date() })
    .where(
      and(
        eq(featureCandidateVoiceChatSessions.id, id),
        eq(featureCandidateVoiceChatSessions.status, "active"),
      ),
    );
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

export async function reactivateVoiceChatCandidateSession(
  id: string,
): Promise<SessionRow> {
  const db = globalThis.services.db;
  const session = await getVoiceChatCandidateSession(id);
  if (!session) {
    throw notFound("Voice-chat-candidate session not found");
  }
  if (session.status === "active") {
    return session;
  }
  const [updated] = await db
    .update(featureCandidateVoiceChatSessions)
    .set({
      status: "active",
      endedAt: null,
      lastHeartbeatAt: new Date(),
    })
    .where(eq(featureCandidateVoiceChatSessions.id, id))
    .returning();
  if (!updated) {
    throw notFound("Voice-chat-candidate session not found");
  }
  return updated;
}

export async function endVoiceChatCandidateSession(id: string): Promise<void> {
  const db = globalThis.services.db;
  const session = await getVoiceChatCandidateSession(id);
  if (!session) {
    throw notFound("Voice-chat-candidate session not found");
  }

  if (session.status === "active") {
    await db
      .update(featureCandidateVoiceChatSessions)
      .set({ status: "ended", endedAt: new Date() })
      .where(
        and(
          eq(featureCandidateVoiceChatSessions.id, id),
          eq(featureCandidateVoiceChatSessions.status, "active"),
        ),
      );
  }

  await cancelSessionPendingRuns({
    id: session.id,
    orgId: session.orgId,
    userId: session.userId,
  });
}
