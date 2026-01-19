import { eq, and } from "drizzle-orm";
import { conversations } from "../../../db/schema/conversation";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentComposeVersions } from "../../../db/schema/agent-compose";
import { NotFoundError, UnauthorizedError } from "../../errors";
import { logger } from "../../logger";
import type { ConversationResolution } from "./types";
import { extractWorkingDir } from "../utils";
import { resolveSessionHistory } from "./resolve-session-history";

const log = logger("run:resolve-conversation");

/**
 * Resolve direct conversation to ConversationResolution
 *
 * @param conversationId Conversation ID to resolve
 * @param agentComposeVersionId Agent compose version ID
 * @param userId User ID for authorization
 * @returns ConversationResolution with all data needed to build execution context
 * @throws NotFoundError if conversation or related data not found
 * @throws UnauthorizedError if conversation doesn't belong to user
 */
export async function resolveDirectConversation(
  conversationId: string,
  agentComposeVersionId: string,
  userId: string,
): Promise<ConversationResolution> {
  log.debug(`Resolving conversation ${conversationId} for user ${userId}`);

  // Load conversation
  const [conversation] = await globalThis.services.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!conversation) {
    throw new NotFoundError("Conversation not found");
  }

  // Verify conversation belongs to user
  const [originalRun] = await globalThis.services.db
    .select()
    .from(agentRuns)
    .where(
      and(eq(agentRuns.id, conversation.runId), eq(agentRuns.userId, userId)),
    )
    .limit(1);

  if (!originalRun) {
    throw new UnauthorizedError(
      "Conversation does not belong to authenticated user",
    );
  }

  // Load agent compose version
  const [version] = await globalThis.services.db
    .select()
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, agentComposeVersionId))
    .limit(1);

  if (!version) {
    throw new NotFoundError("Agent compose version not found");
  }

  // Resolve session history from R2 hash or legacy TEXT field
  const sessionHistory = await resolveSessionHistory(
    conversation.cliAgentSessionHistoryHash,
    conversation.cliAgentSessionHistory,
  );

  return {
    conversationId,
    agentComposeVersionId,
    agentCompose: version.content,
    workingDir: extractWorkingDir(version.content),
    conversationData: {
      cliAgentSessionId: conversation.cliAgentSessionId,
      cliAgentSessionHistory: sessionHistory,
    },
    // No defaults for artifact/vars/secrets/volumeVersions - use params directly
    buildResumeArtifact: false,
  };
}
