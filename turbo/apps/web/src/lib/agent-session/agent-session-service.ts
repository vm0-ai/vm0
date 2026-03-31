import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { agentSessions } from "../../db/schema/agent-session";
import {
  zeroAgentSessions,
  type StoredChatMessage,
} from "../../db/schema/zero-agent-session";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { conversations } from "../../db/schema/conversation";
import { extractAndGroupVariables, type SummaryEntry } from "@vm0/core";
import { notFound, forbidden } from "../errors";
import type {
  AgentSessionData,
  AgentSessionWithConversation,
  CreateAgentSessionInput,
} from "./types";
import type { SessionResponse } from "@vm0/core";

/**
 * Agent Session Service - Pure Functions
 * Manages VM0 agent sessions - lightweight compose ↔ conversation associations
 * Sessions always use HEAD compose version at runtime — no snapshotting
 */

/**
 * Get agent session by ID with conversation data
 * Used for continue operations
 */
export async function getAgentSessionWithConversation(
  id: string,
): Promise<AgentSessionWithConversation | null> {
  const [result] = await globalThis.services.db
    .select({
      session: agentSessions,
      conversation: conversations,
    })
    .from(agentSessions)
    .leftJoin(conversations, eq(agentSessions.conversationId, conversations.id))
    .where(eq(agentSessions.id, id))
    .limit(1);

  if (!result) {
    return null;
  }

  return {
    ...mapToAgentSessionData(result.session),
    conversation: result.conversation
      ? {
          id: result.conversation.id,
          runId: result.conversation.runId,
          cliAgentType: result.conversation.cliAgentType,
          cliAgentSessionId: result.conversation.cliAgentSessionId,
          cliAgentSessionHistory: result.conversation.cliAgentSessionHistory,
          cliAgentSessionHistoryHash:
            result.conversation.cliAgentSessionHistoryHash,
        }
      : null,
  };
}

/**
 * Create a new agent session
 */
export async function createAgentSession(
  input: CreateAgentSessionInput,
): Promise<AgentSessionData> {
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({
      userId: input.userId,
      orgId: input.orgId,
      agentComposeId: input.agentComposeId,
      artifactName: input.artifactName,
      memoryName: input.memoryName,
      conversationId: input.conversationId,
    })
    .returning();

  if (!session) {
    throw new Error("Failed to create agent session");
  }

  return mapToAgentSessionData(session);
}

/**
 * Update an existing agent session's conversation reference
 */
export async function updateAgentSession(
  id: string,
  conversationId: string,
): Promise<AgentSessionData> {
  const [session] = await globalThis.services.db
    .update(agentSessions)
    .set({
      conversationId,
      updatedAt: new Date(),
    })
    .where(eq(agentSessions.id, id))
    .returning();

  if (!session) {
    throw notFound("AgentSession not found");
  }

  return mapToAgentSessionData(session);
}

/**
 * List chat sessions for a user + agent compose (no artifact).
 * Only returns sessions that have at least one chat message.
 */
export async function listAgentSessions(
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
 * Get chat messages for a session by ID.
 */
export async function getSessionChatMessages(
  sessionId: string,
): Promise<StoredChatMessage[]> {
  const [row] = await globalThis.services.db
    .select({ chatMessages: zeroAgentSessions.chatMessages })
    .from(zeroAgentSessions)
    .where(eq(zeroAgentSessions.id, sessionId))
    .limit(1);

  if (!row) {
    return [];
  }

  return (row.chatMessages ?? []) as StoredChatMessage[];
}

/**
 * Append chat messages to a session's chatMessages JSONB array.
 * Adds server-side createdAt timestamp to each message.
 */
export async function appendChatMessages(
  sessionId: string,
  userId: string,
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    runId?: string;
    summaries?: SummaryEntry[];
  }>,
): Promise<void> {
  const now = new Date().toISOString();
  const withTimestamps = messages.map((m) => {
    return { ...m, createdAt: now };
  });

  await globalThis.services.db.transaction(async (tx) => {
    // Verify session ownership
    const [session] = await tx
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(
        and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)),
      )
      .limit(1);

    if (!session) {
      throw notFound("Session not found or not owned by user");
    }

    // Upsert messages into extension table
    await tx
      .insert(zeroAgentSessions)
      .values({
        id: sessionId,
        chatMessages: sql`${JSON.stringify(withTimestamps)}::jsonb`,
      })
      .onConflictDoUpdate({
        target: zeroAgentSessions.id,
        set: {
          chatMessages: sql`COALESCE(${zeroAgentSessions.chatMessages}, '[]'::jsonb) || ${JSON.stringify(withTimestamps)}::jsonb`,
        },
      });

    // Update session timestamp
    await tx
      .update(agentSessions)
      .set({ updatedAt: new Date() })
      .where(eq(agentSessions.id, sessionId));
  });
}

function mapToAgentSessionData(
  session: typeof agentSessions.$inferSelect,
): AgentSessionData {
  return {
    id: session.id,
    userId: session.userId,
    orgId: session.orgId,
    agentComposeId: session.agentComposeId,
    conversationId: session.conversationId,
    artifactName: session.artifactName,
    memoryName: session.memoryName,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
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
