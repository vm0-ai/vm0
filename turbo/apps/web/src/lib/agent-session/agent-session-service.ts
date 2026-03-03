import { eq, and, isNull, desc, sql } from "drizzle-orm";
import {
  agentSessions,
  type StoredChatMessage,
} from "../../db/schema/agent-session";
import { conversations } from "../../db/schema/conversation";
import { notFound } from "../errors";
import type {
  AgentSessionData,
  AgentSessionWithConversation,
  CreateAgentSessionInput,
} from "./types";

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
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.agentComposeId, agentComposeId),
        isNull(agentSessions.artifactName),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt));

  return rows
    .map((row) => {
      const messages = (row.chatMessages ?? []) as StoredChatMessage[];
      const firstUserMsg = messages.find((m) => m.role === "user");
      return {
        id: row.id,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        messageCount: messages.length,
        preview: firstUserMsg ? firstUserMsg.content.slice(0, 100) : null,
      };
    })
    .filter((s) => s.messageCount > 0);
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
  }>,
): Promise<void> {
  const now = new Date().toISOString();
  const withTimestamps = messages.map((m) => ({ ...m, createdAt: now }));

  const result = await globalThis.services.db
    .update(agentSessions)
    .set({
      chatMessages: sql`COALESCE(${agentSessions.chatMessages}, '[]'::jsonb) || ${JSON.stringify(withTimestamps)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)),
    )
    .returning({ id: agentSessions.id });

  if (result.length === 0) {
    throw notFound("Session not found or not owned by user");
  }
}

function mapToAgentSessionData(
  session: typeof agentSessions.$inferSelect,
): AgentSessionData {
  return {
    id: session.id,
    userId: session.userId,
    agentComposeId: session.agentComposeId,
    conversationId: session.conversationId,
    artifactName: session.artifactName,
    memoryName: session.memoryName,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
