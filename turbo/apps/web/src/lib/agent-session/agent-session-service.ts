import { eq, and, isNull } from "drizzle-orm";
import { agentSessions } from "../../db/schema/agent-session";
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
 * Find existing session or create a new one
 * Used when checkpoint is created to ensure session exists
 * Note: artifactName is optional - sessions without artifact use (userId, composeId) as key
 */
export async function findOrCreateAgentSession(
  userId: string,
  agentComposeId: string,
  artifactName?: string,
  conversationId?: string,
): Promise<{ session: AgentSessionData; created: boolean }> {
  // Build query conditions - handle null artifactName for sessions without artifact
  // For sessions with artifact: match (userId, composeId, artifactName)
  // For sessions without artifact: match (userId, composeId, artifactName IS NULL)
  const conditions = artifactName
    ? and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.agentComposeId, agentComposeId),
        eq(agentSessions.artifactName, artifactName),
      )
    : and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.agentComposeId, agentComposeId),
        isNull(agentSessions.artifactName),
      );

  // Find existing session with same compose and artifact
  const [existing] = await globalThis.services.db
    .select()
    .from(agentSessions)
    .where(conditions)
    .limit(1);

  if (existing) {
    // Update conversation reference if provided
    if (conversationId) {
      const updated = await updateAgentSession(existing.id, conversationId);
      return { session: updated, created: false };
    }
    return { session: mapToAgentSessionData(existing), created: false };
  }

  // Create new session
  const session = await createAgentSession({
    userId,
    agentComposeId,
    artifactName,
    conversationId,
  });

  return { session, created: true };
}

/**
 * Create a new agent session
 */
async function createAgentSession(
  input: CreateAgentSessionInput,
): Promise<AgentSessionData> {
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({
      userId: input.userId,
      agentComposeId: input.agentComposeId,
      artifactName: input.artifactName,
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
async function updateAgentSession(
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

function mapToAgentSessionData(
  session: typeof agentSessions.$inferSelect,
): AgentSessionData {
  return {
    id: session.id,
    userId: session.userId,
    agentComposeId: session.agentComposeId,
    conversationId: session.conversationId,
    artifactName: session.artifactName,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
