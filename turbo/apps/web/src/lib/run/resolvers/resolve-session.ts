import { eq } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { agentRuns } from "../../../db/schema/agent-run";
import { notFound, unauthorized, badRequest } from "../../errors";
import { logger } from "../../logger";
import { getAgentSessionWithConversation } from "../../agent-session";
import type { ConversationResolution } from "./types";
import { extractWorkingDir, extractCliAgentType } from "../utils";
import { resolveSessionHistory } from "./resolve-session-history";

const log = logger("run:resolve-session");

/**
 * Resolve session to ConversationResolution
 * Always uses HEAD compose version — continue behaves like a new run + conversation history
 *
 * @param sessionId Agent session ID to resolve
 * @param userId User ID for authorization
 * @returns ConversationResolution with all data needed to build execution context
 * @throws NotFoundError if session or related data not found
 * @throws UnauthorizedError if session doesn't belong to user
 * @throws BadRequestError if session data is invalid or framework changed
 */
export async function resolveSession(
  sessionId: string,
  userId: string,
): Promise<ConversationResolution> {
  log.debug(`Resolving session ${sessionId} for user ${userId}`);

  const session = await getAgentSessionWithConversation(sessionId);

  if (!session) {
    throw notFound("Agent session not found");
  }

  if (session.userId !== userId) {
    throw unauthorized("Agent session does not belong to authenticated user");
  }

  if (!session.conversation) {
    throw notFound(
      "Agent session has no conversation history to continue from",
    );
  }

  if (!session.conversationId) {
    throw notFound("Agent session has no conversation ID");
  }

  // Load agent compose
  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.id, session.agentComposeId))
    .limit(1);

  if (!compose) {
    throw notFound("Agent compose not found");
  }

  if (!compose.headVersionId) {
    throw badRequest("Agent compose has no versions. Run 'vm0 build' first.");
  }

  // Always use HEAD compose version — continue behaves like a new run + conversation history
  const versionId = compose.headVersionId;

  // Get compose version content
  const [version] = await globalThis.services.db
    .select()
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);

  if (!version) {
    throw notFound(`Agent compose version ${versionId} not found`);
  }

  // Framework compatibility check: block continue if framework changed
  const headFramework = extractCliAgentType(version.content);
  const sessionFramework = session.conversation.cliAgentType;
  if (headFramework !== sessionFramework) {
    throw badRequest(
      `Cannot continue session: framework changed from "${sessionFramework}" to "${headFramework}". ` +
        `Start a new run instead.`,
    );
  }

  // Resolve session history from R2 hash or legacy TEXT field
  const sessionHistory = await resolveSessionHistory(
    session.conversation.cliAgentSessionHistoryHash,
    session.conversation.cliAgentSessionHistory,
  );

  // Read vars from the last run as fallback for continue operations
  const [lastRun] = await globalThis.services.db
    .select({ vars: agentRuns.vars })
    .from(agentRuns)
    .where(eq(agentRuns.id, session.conversation.runId))
    .limit(1);

  const lastRunVars =
    (lastRun?.vars as Record<string, string> | null) ?? undefined;

  return {
    conversationId: session.conversationId,
    agentComposeVersionId: versionId,
    agentCompose: version.content,
    workingDir: extractWorkingDir(version.content),
    conversationData: {
      cliAgentSessionId: session.conversation.cliAgentSessionId,
      cliAgentSessionHistory: sessionHistory,
    },
    artifactName: session.artifactName ?? undefined,
    artifactVersion: session.artifactName ? "latest" : undefined,
    vars: lastRunVars,
    secretNames: undefined,
    volumeVersions: undefined,
    buildResumeArtifact: !!session.artifactName,
  };
}
