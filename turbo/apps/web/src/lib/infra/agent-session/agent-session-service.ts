import { eq } from "drizzle-orm";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { conversations } from "@vm0/db/schema/conversation";
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

function mapToAgentSessionData(
  session: typeof agentSessions.$inferSelect,
): AgentSessionData {
  return {
    id: session.id,
    userId: session.userId,
    orgId: session.orgId,
    agentComposeId: session.agentComposeId,
    conversationId: session.conversationId,
    artifacts: session.artifacts,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
