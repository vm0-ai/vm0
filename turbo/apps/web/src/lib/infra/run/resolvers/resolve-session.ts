import { eq } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { notFound, unauthorized, badRequest } from "@vm0/api-services/errors";
import { logger } from "../../../shared/logger";
import { getAgentSessionWithConversation } from "../../agent-session";
import type { ConversationResolution } from "./types";
import { extractWorkingDir } from "../utils";
import { resolveSessionHistory } from "./resolve-session-history";
import type { VolumeVersionsSnapshot } from "../../checkpoint/types";
import { decodeToContextArtifacts } from "../../checkpoint/decode-artifact-snapshots";

const log = logger("run:resolve-session");

const FAILED_RECOVERABLE_RUN_STATUSES = new Set([
  "failed",
  "timeout",
  "cancelled",
]);

/**
 * Resolve session to ConversationResolution
 * Always uses HEAD compose version — continue behaves like a new run + conversation history
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
  // - Compose → version chain (needs session.agentComposeId)
  // - Session history from R2 (needs session.conversation)
  // - Last run vars and optional failed-recovery checkpoint snapshot
  //   (needs conversation.runId)
  const [composeResult, sessionHistory, runSnapshotResult] = await Promise.all([
    // Compose → version (serial chain)
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

      return { versionId, version };
    })(),
    // Session history from R2 hash or legacy TEXT field
    resolveSessionHistory(
      conversation.cliAgentSessionHistoryHash,
      conversation.cliAgentSessionHistory,
    ),
    // Last run vars as fallback for continue operations. When the linked
    // conversation belongs to a terminal failed run with a checkpoint, the
    // checkpoint snapshot is the only durable workspace state left after VM
    // teardown, so session continue must restore from it.
    globalThis.services.db
      .select({
        vars: agentRuns.vars,
        status: agentRuns.status,
        checkpointId: checkpoints.id,
        artifactSnapshots: checkpoints.artifactSnapshots,
        volumeVersionsSnapshot: checkpoints.volumeVersionsSnapshot,
      })
      .from(agentRuns)
      .leftJoin(checkpoints, eq(checkpoints.runId, agentRuns.id))
      .where(eq(agentRuns.id, conversation.runId))
      .limit(1),
  ]);

  const { versionId, version } = composeResult;
  const [lastRun] = runSnapshotResult;
  const lastRunVars =
    (lastRun?.vars as Record<string, string> | null) ?? undefined;
  const failedRecoveryCheckpoint = Boolean(
    lastRun?.checkpointId &&
    FAILED_RECOVERABLE_RUN_STATUSES.has(lastRun.status),
  );
  const checkpointVolumeVersions = failedRecoveryCheckpoint
    ? (lastRun?.volumeVersionsSnapshot as VolumeVersionsSnapshot | null)
    : null;
  const checkpointAdditionalVolumes =
    checkpointVolumeVersions?.additionalVolumes?.map((vol) => {
      return {
        name: vol.name,
        version: vol.versionId,
        mountPath: vol.mountPath,
      };
    });
  const checkpointArtifacts = failedRecoveryCheckpoint
    ? lastRun?.artifactSnapshots
    : null;
  const artifacts = failedRecoveryCheckpoint
    ? decodeToContextArtifacts(checkpointArtifacts)
    : session.artifacts;
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
    artifacts,
    vars: lastRunVars,
    volumeVersions: checkpointVolumeVersions?.versions,
    additionalVolumes: checkpointAdditionalVolumes,
    previousRunId: conversation.runId,
    sessionFramework: conversation.cliAgentType,
  };
}
