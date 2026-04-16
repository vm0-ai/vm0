import { eq } from "drizzle-orm";
import { agentSessions } from "../../../db/schema/agent-session";
import { conversations } from "../../../db/schema/conversation";
import { notFound } from "../../shared/errors";
import type {
  AgentSessionData,
  AgentSessionWithConversation,
  CreateAgentSessionInput,
} from "./types";

/**
 * Agent Session Service - Pure Infra Functions
 * Manages VM0 agent sessions - lightweight compose <-> conversation associations
 * Sessions always use HEAD compose version at runtime -- no snapshotting
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
