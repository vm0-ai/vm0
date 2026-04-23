import { eq } from "drizzle-orm";
import { agentSessions } from "../../../db/schema/agent-session";
import { conversations } from "../../../db/schema/conversation";
import { notFound } from "../../shared/errors";
import type { AgentSessionData, AgentSessionWithConversation } from "./types";

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
 * Bind an agent session to its conversation. Called by the checkpoint
 * webhook once the CLI-side session history is uploaded and the
 * conversation row is upserted. Sessions are created eagerly at run
 * insertion; artifactName/memoryName are populated then, not here.
 */
export async function updateAgentSession(
  id: string,
  conversationId: string,
): Promise<AgentSessionData> {
  const [session] = await globalThis.services.db
    .update(agentSessions)
    .set({ conversationId, updatedAt: new Date() })
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
