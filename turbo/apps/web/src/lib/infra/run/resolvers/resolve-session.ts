import { eq } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../db/schema/agent-compose";
import { agentRuns } from "../../../../db/schema/agent-run";
import { notFound, unauthorized, badRequest } from "../../../shared/errors";
import { logger } from "../../../shared/logger";
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

  // Capture narrowed conversation for use in parallel closures
  // (TypeScript doesn't narrow across async IIFE boundaries)
  const conversation = session.conversation;

  // Run independent operations in parallel:
  // - Compose → version → framework check chain (needs session.agentComposeId)
  // - Session history from R2 (needs session.conversation)
  // - Last run vars (needs conversation.runId)
  const [composeResult, sessionHistory, lastRunResult] = await Promise.all([
    // Compose → version → framework check (serial chain)
    (async () => {
      const [compose] = await globalThis.services.db
        .select()
        .from(agentComposes)
        .where(eq(agentComposes.id, session.agentComposeId))
        .limit(1);

      if (!compose) {
        throw notFound("Agent compose not found");
      }

      if (!compose.headVersionId) {
        throw badRequest(
          "Agent compose has no versions. Run 'vm0 build' first.",
        );
      }

      const versionId = compose.headVersionId;

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
      const sessionFramework = conversation.cliAgentType;
      if (headFramework !== sessionFramework) {
        throw badRequest(
          `Cannot continue session: framework changed from "${sessionFramework}" to "${headFramework}". ` +
            `Start a new run instead.`,
        );
      }

      return { versionId, version };
    })(),
    // Session history from R2 hash or legacy TEXT field
    resolveSessionHistory(
      conversation.cliAgentSessionHistoryHash,
      conversation.cliAgentSessionHistory,
    ),
    // Last run vars as fallback for continue operations
    globalThis.services.db
      .select({
        vars: agentRuns.vars,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, conversation.runId))
      .limit(1),
  ]);

  const { versionId, version } = composeResult;
  const [lastRun] = lastRunResult;
  const lastRunVars =
    (lastRun?.vars as Record<string, string> | null) ?? undefined;
  const workingDir = extractWorkingDir(version.content);

  return {
    conversationId: session.conversationId,
    agentComposeVersionId: versionId,
    agentCompose: version.content,
    workingDir,
    conversationData: {
      cliAgentSessionId: conversation.cliAgentSessionId,
      cliAgentSessionHistory: sessionHistory,
    },
    artifacts: session.artifacts,
    vars: lastRunVars,
    volumeVersions: undefined,
    previousRunId: conversation.runId,
  };
}
