import { eq } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import {
  NotFoundError,
  UnauthorizedError,
  BadRequestError,
} from "../../errors";
import { logger } from "../../logger";
import { agentSessionService } from "../../agent-session";
import type { ConversationResolution } from "./types";
import { extractWorkingDir } from "../utils";
import { resolveSessionHistory } from "./resolve-session-history";

const log = logger("run:resolve-session");

/**
 * Resolve session to ConversationResolution
 * Uses session's fixed compose version if available, falls back to HEAD for backwards compatibility
 *
 * @param sessionId Agent session ID to resolve
 * @param userId User ID for authorization
 * @returns ConversationResolution with all data needed to build execution context
 * @throws NotFoundError if session or related data not found
 * @throws UnauthorizedError if session doesn't belong to user
 * @throws BadRequestError if session data is invalid
 */
export async function resolveSession(
  sessionId: string,
  userId: string,
): Promise<ConversationResolution> {
  log.debug(`Resolving session ${sessionId} for user ${userId}`);

  const session = await agentSessionService.getByIdWithConversation(sessionId);

  if (!session) {
    throw new NotFoundError("Agent session not found");
  }

  if (session.userId !== userId) {
    throw new UnauthorizedError(
      "Agent session does not belong to authenticated user",
    );
  }

  if (!session.conversation) {
    throw new NotFoundError(
      "Agent session has no conversation history to continue from",
    );
  }

  if (!session.conversationId) {
    throw new NotFoundError("Agent session has no conversation ID");
  }

  // Load agent compose
  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.id, session.agentComposeId))
    .limit(1);

  if (!compose) {
    throw new NotFoundError("Agent compose not found");
  }

  if (!compose.headVersionId) {
    throw new BadRequestError(
      "Agent compose has no versions. Run 'vm0 build' first.",
    );
  }

  // Use session's fixed compose version if available, fall back to HEAD for backwards compatibility
  // This ensures reproducibility: continue uses the same compose version as the original run
  const versionId = session.agentComposeVersionId || compose.headVersionId;

  // Get compose version content
  const [version] = await globalThis.services.db
    .select()
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);

  if (!version) {
    throw new NotFoundError(`Agent compose version ${versionId} not found`);
  }

  // Get secret names from session (values are NEVER stored)
  const secretNames = session.secretNames ?? undefined;

  // Resolve session history from R2 hash or legacy TEXT field
  const sessionHistory = await resolveSessionHistory(
    session.conversation.cliAgentSessionHistoryHash,
    session.conversation.cliAgentSessionHistory,
  );

  return {
    conversationId: session.conversationId,
    agentComposeVersionId: versionId,
    agentCompose: version.content,
    workingDir: extractWorkingDir(version.content),
    conversationData: {
      cliAgentSessionId: session.conversation.cliAgentSessionId,
      cliAgentSessionHistory: sessionHistory,
    },
    artifactName: session.artifactName ?? undefined, // Convert null to undefined
    artifactVersion: session.artifactName ? "latest" : undefined, // Only set version if artifact exists
    vars: session.vars || {},
    secretNames,
    // Use session's volume versions if available for reproducibility
    volumeVersions: session.volumeVersions || undefined,
    buildResumeArtifact: !!session.artifactName, // Only build resumeArtifact if session has artifact
  };
}
