import { eq, and, isNull } from "drizzle-orm";
import { agentSessions } from "../../db/schema/agent-session";
import { conversations } from "../../db/schema/conversation";
import { notFound } from "../errors";
import type {
  AgentSessionData,
  AgentSessionWithConversation,
  CreateAgentSessionInput,
  UpdateAgentSessionInput,
} from "./types";

/**
 * Agent Session Service - Pure Functions
 * Manages VM0 agent sessions - persistent running contexts across multiple runs
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
 * Note: agentComposeVersionId and volumeVersions are only set on creation, not updated
 * Note: secrets values are NEVER stored - only names for validation
 */
export async function findOrCreateAgentSession(
  userId: string,
  agentComposeId: string,
  artifactName?: string,
  conversationId?: string,
  vars?: Record<string, string>,
  secretNames?: string[],
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
    // Update conversation, vars, and secret names if provided
    // Note: agentComposeVersionId and volumeVersions are NOT updated - they are fixed at creation
    if (conversationId) {
      const updated = await updateAgentSession(existing.id, {
        conversationId,
        vars,
        secretNames,
      });
      return { session: updated, created: false };
    }
    return { session: mapToAgentSessionData(existing), created: false };
  }

  // Create new session with version ID and volume versions fixed at creation
  const session = await createAgentSession({
    userId,
    agentComposeId,
    agentComposeVersionId,
    artifactName,
    conversationId,
    vars,
    secretNames,
    volumeVersions,
  });

  return { session, created: true };
}

/**
 * Create a new agent session
 * Note: secrets values are NEVER stored - only names for validation
 */
async function createAgentSession(
  input: CreateAgentSessionInput,
): Promise<AgentSessionData> {
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({
      userId: input.userId,
      agentComposeId: input.agentComposeId,
      agentComposeVersionId: input.agentComposeVersionId,
      artifactName: input.artifactName,
      conversationId: input.conversationId,
      vars: input.vars,
      // Store only secret names, never values
      secretNames: input.secretNames,
      volumeVersions: input.volumeVersions,
    })
    .returning();

  if (!session) {
    throw new Error("Failed to create agent session");
  }

  return mapToAgentSessionData(session);
}

/**
 * Update an existing agent session's conversation reference, vars and secret names
 * Note: secrets values are NEVER stored - only names for validation
 */
async function updateAgentSession(
  id: string,
  input: UpdateAgentSessionInput,
): Promise<AgentSessionData> {
  const updateData: {
    conversationId: string;
    updatedAt: Date;
    vars?: Record<string, string>;
    secretNames?: string[];
  } = {
    conversationId: input.conversationId,
    updatedAt: new Date(),
  };

  if (input.vars !== undefined) {
    updateData.vars = input.vars;
  }

  // Store only secret names, never values
  if (input.secretNames !== undefined) {
    updateData.secretNames = input.secretNames;
  }

  const [session] = await globalThis.services.db
    .update(agentSessions)
    .set(updateData)
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
    agentComposeVersionId: session.agentComposeVersionId,
    conversationId: session.conversationId,
    artifactName: session.artifactName,
    vars: session.vars,
    secretNames: session.secretNames ?? null,
    volumeVersions: session.volumeVersions,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
