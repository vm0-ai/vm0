import { eq, and, isNull, desc } from "drizzle-orm";
import { agentSessions } from "../../db/schema/agent-session";
import {
  zeroAgentSessions,
  type StoredChatMessage,
} from "../../db/schema/zero-agent-session";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { extractAndGroupVariables } from "@vm0/core";
import { notFound, forbidden } from "../shared/errors";
import type { SessionResponse } from "@vm0/core";

/**
 * Zero Session Service
 * Owns all zeroAgentSessions table operations — chat message persistence,
 * session listing with messages, and session response building.
 */

/**
 * List chat sessions for a user + agent compose (no artifact).
 * Only returns sessions that have at least one chat message.
 */
export async function listSessionsWithMessages(
  userId: string,
  agentComposeId: string,
): Promise<
  Array<{
    id: string;
    createdAt: Date;
    updatedAt: Date;
    messageCount: number;
    preview: string | null;
  }>
> {
  const rows = await globalThis.services.db
    .select({
      id: agentSessions.id,
      createdAt: agentSessions.createdAt,
      updatedAt: agentSessions.updatedAt,
      chatMessages: zeroAgentSessions.chatMessages,
    })
    .from(agentSessions)
    .leftJoin(zeroAgentSessions, eq(agentSessions.id, zeroAgentSessions.id))
    .where(
      and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.agentComposeId, agentComposeId),
        isNull(agentSessions.artifactName),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt));

  return rows.map((row) => {
    const messages = (row.chatMessages ?? []) as StoredChatMessage[];
    const firstUserMsg = messages.find((m) => {
      return m.role === "user";
    });
    return {
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount: messages.length,
      preview: firstUserMsg ? firstUserMsg.content.slice(0, 100) : null,
    };
  });
}

/**
 * Get a session by ID with ownership + org verification,
 * returning the full API response shape including secret names.
 *
 * Throws notFound if session doesn't exist or belongs to different org.
 * Throws forbidden if session belongs to a different user.
 */
export async function getSessionResponse(
  sessionId: string,
  userId: string,
  orgId: string,
): Promise<SessionResponse> {
  const db = globalThis.services.db;

  const [result] = await db
    .select({
      session: agentSessions,
      chatMessages: zeroAgentSessions.chatMessages,
    })
    .from(agentSessions)
    .leftJoin(zeroAgentSessions, eq(agentSessions.id, zeroAgentSessions.id))
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  if (!result) {
    throw notFound("Session not found");
  }

  const session = result.session;

  if (session.userId !== userId) {
    throw forbidden("You do not have permission to access this session");
  }

  if (orgId !== session.orgId) {
    throw notFound("Session not found");
  }

  // Extract secret names from HEAD compose content
  let secretNames: string[] | null = null;
  const [compose] = await db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.id, session.agentComposeId))
    .limit(1);

  if (compose?.headVersionId) {
    const [version] = await db
      .select()
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, compose.headVersionId))
      .limit(1);

    if (version?.content) {
      const grouped = extractAndGroupVariables(version.content);
      const names = grouped.secrets.map((ref) => {
        return ref.name;
      });
      secretNames = names.length > 0 ? names : null;
    }
  }

  return {
    id: session.id,
    agentComposeId: session.agentComposeId,
    conversationId: session.conversationId,
    artifactName: session.artifactName,
    secretNames,
    chatMessages: result.chatMessages ?? [],
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

/**
 * Get all sessions with their chat messages for a user.
 * Used by export-service to avoid direct zeroAgentSessions access.
 */
export async function getAllSessionsWithMessages(userId: string): Promise<
  Array<{
    id: string;
    chatMessages: StoredChatMessage[];
    conversationId: string | null;
    agentComposeId: string;
  }>
> {
  const sessions = await globalThis.services.db
    .select({
      id: agentSessions.id,
      chatMessages: zeroAgentSessions.chatMessages,
      conversationId: agentSessions.conversationId,
      agentComposeId: agentSessions.agentComposeId,
    })
    .from(agentSessions)
    .leftJoin(zeroAgentSessions, eq(agentSessions.id, zeroAgentSessions.id))
    .where(eq(agentSessions.userId, userId));

  return sessions.map((s) => {
    return {
      id: s.id,
      chatMessages: (s.chatMessages ?? []) as StoredChatMessage[],
      conversationId: s.conversationId,
      agentComposeId: s.agentComposeId,
    };
  });
}
