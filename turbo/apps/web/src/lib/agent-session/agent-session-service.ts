import { eq, and, isNull } from "drizzle-orm";
import { agentSessions } from "../../db/schema/agent-session";
import { conversations } from "../../db/schema/conversation";
import { NotFoundError } from "../errors";
import type {
  AgentSessionData,
  AgentSessionWithConversation,
  CreateAgentSessionInput,
  UpdateAgentSessionInput,
} from "./types";

/**
 * Agent Session Service
 * Manages VM0 agent sessions - persistent running contexts across multiple runs
 */
export class AgentSessionService {
  /**
   * Create a new agent session
   */
  async create(input: CreateAgentSessionInput): Promise<AgentSessionData> {
    const [session] = await globalThis.services.db
      .insert(agentSessions)
      .values({
        userId: input.userId,
        agentComposeId: input.agentComposeId,
        agentComposeVersionId: input.agentComposeVersionId,
        artifactName: input.artifactName,
        conversationId: input.conversationId,
        vars: input.vars,
        secrets: input.secrets,
        volumeVersions: input.volumeVersions,
      })
      .returning();

    if (!session) {
      throw new Error("Failed to create agent session");
    }

    return this.mapToAgentSessionData(session);
  }

  /**
   * Update an existing agent session's conversation reference, vars and secrets
   */
  async update(
    id: string,
    input: UpdateAgentSessionInput,
  ): Promise<AgentSessionData> {
    const updateData: {
      conversationId: string;
      updatedAt: Date;
      vars?: Record<string, string>;
      secrets?: Record<string, string>;
    } = {
      conversationId: input.conversationId,
      updatedAt: new Date(),
    };

    if (input.vars !== undefined) {
      updateData.vars = input.vars;
    }

    if (input.secrets !== undefined) {
      updateData.secrets = input.secrets;
    }

    const [session] = await globalThis.services.db
      .update(agentSessions)
      .set(updateData)
      .where(eq(agentSessions.id, id))
      .returning();

    if (!session) {
      throw new NotFoundError("AgentSession not found");
    }

    return this.mapToAgentSessionData(session);
  }

  /**
   * Get agent session by ID
   */
  async getById(id: string): Promise<AgentSessionData | null> {
    const [session] = await globalThis.services.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);

    return session ? this.mapToAgentSessionData(session) : null;
  }

  /**
   * Get agent session by ID with conversation data
   * Used for continue operations
   */
  async getByIdWithConversation(
    id: string,
  ): Promise<AgentSessionWithConversation | null> {
    const [result] = await globalThis.services.db
      .select({
        session: agentSessions,
        conversation: conversations,
      })
      .from(agentSessions)
      .leftJoin(
        conversations,
        eq(agentSessions.conversationId, conversations.id),
      )
      .where(eq(agentSessions.id, id))
      .limit(1);

    if (!result) {
      return null;
    }

    return {
      ...this.mapToAgentSessionData(result.session),
      conversation: result.conversation
        ? {
            id: result.conversation.id,
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
   * Get all agent sessions for a user
   */
  async getByUserId(userId: string): Promise<AgentSessionData[]> {
    const sessions = await globalThis.services.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.userId, userId));

    return sessions.map(this.mapToAgentSessionData);
  }

  /**
   * Find existing session or create a new one
   * Used when checkpoint is created to ensure session exists
   * Note: artifactName is optional - sessions without artifact use (userId, composeId) as key
   * Note: agentComposeVersionId and volumeVersions are only set on creation, not updated
   */
  async findOrCreate(
    userId: string,
    agentComposeId: string,
    artifactName?: string,
    conversationId?: string,
    vars?: Record<string, string>,
    secrets?: Record<string, string>,
    agentComposeVersionId?: string,
    volumeVersions?: Record<string, string>,
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
      // Update conversation, vars, and secrets if provided
      // Note: agentComposeVersionId and volumeVersions are NOT updated - they are fixed at creation
      if (conversationId) {
        const updated = await this.update(existing.id, {
          conversationId,
          vars,
          secrets,
        });
        return { session: updated, created: false };
      }
      return { session: this.mapToAgentSessionData(existing), created: false };
    }

    // Create new session with version ID and volume versions fixed at creation
    const session = await this.create({
      userId,
      agentComposeId,
      agentComposeVersionId,
      artifactName,
      conversationId,
      vars,
      secrets,
      volumeVersions,
    });

    return { session, created: true };
  }

  /**
   * Delete an agent session
   */
  async delete(id: string): Promise<boolean> {
    const result = await globalThis.services.db
      .delete(agentSessions)
      .where(eq(agentSessions.id, id))
      .returning({ id: agentSessions.id });

    return result.length > 0;
  }

  private mapToAgentSessionData(
    session: typeof agentSessions.$inferSelect,
  ): AgentSessionData {
    return {
      id: session.id,
      userId: session.userId,
      agentComposeId: session.agentComposeId,
      agentComposeVersionId: session.agentComposeVersionId,
      conversationId: session.conversationId,
      artifactName: session.artifactName,
      vars: session.vars,
      secrets: session.secrets,
      volumeVersions: session.volumeVersions,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}

// Export singleton instance
export const agentSessionService = new AgentSessionService();
