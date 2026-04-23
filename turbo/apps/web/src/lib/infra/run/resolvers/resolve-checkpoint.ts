import { eq, and } from "drizzle-orm";
import { checkpoints } from "../../../../db/schema/checkpoint";
import { conversations } from "../../../../db/schema/conversation";
import { agentRuns } from "../../../../db/schema/agent-run";
import { agentComposeVersions } from "../../../../db/schema/agent-compose";
import { notFound, unauthorized, badRequest } from "../../../shared/errors";
import { logger } from "../../../shared/logger";
import type {
  AgentComposeSnapshot,
  VolumeVersionsSnapshot,
} from "../../checkpoint/types";
import type { AgentComposeYaml } from "../../agent-compose/types";
import type { ConversationResolution } from "./types";
import type { ContextArtifact } from "../types";
import {
  AUTO_MEMORY_ARTIFACT_NAME,
  AUTO_MEMORY_MOUNT_PATH,
} from "../../storage/types";
import { extractWorkingDir } from "../utils";
import { resolveSessionHistory } from "./resolve-session-history";

const log = logger("run:resolve-checkpoint");

/**
 * Resolve checkpoint to ConversationResolution
 *
 * @param checkpointId Checkpoint ID to resolve
 * @param userId User ID for authorization
 * @returns ConversationResolution with all data needed to build execution context
 * @throws NotFoundError if checkpoint or related data not found
 * @throws UnauthorizedError if checkpoint doesn't belong to user
 * @throws BadRequestError if checkpoint data is invalid
 */
export async function resolveCheckpoint(
  checkpointId: string,
  userId: string,
): Promise<ConversationResolution> {
  log.debug(`Resolving checkpoint ${checkpointId} for user ${userId}`);

  const [checkpoint] = await globalThis.services.db
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.id, checkpointId))
    .limit(1);

  if (!checkpoint) {
    throw notFound("Checkpoint not found");
  }

  // Extract snapshots. Artifact entries are stored directly in
  // checkpoint.artifactSnapshots — no join to agent_sessions required.
  const agentComposeSnapshot =
    checkpoint.agentComposeSnapshot as unknown as AgentComposeSnapshot;
  // artifactSnapshots is a Drizzle jsonb column (runtime type `unknown`).
  // decodeCheckpointArtifacts does the runtime shape check; never cast here.
  const rawArtifacts: unknown = checkpoint.artifactSnapshots;
  const checkpointVolumeVersions =
    checkpoint.volumeVersionsSnapshot as VolumeVersionsSnapshot | null;

  // Extract additional volumes from enriched snapshot (pinned versions from checkpoint)
  const checkpointAdditionalVolumes =
    checkpointVolumeVersions?.additionalVolumes?.map((vol) => {
      return {
        name: vol.name,
        version: vol.versionId,
        mountPath: vol.mountPath,
      };
    });

  // Get version ID from snapshot
  const agentComposeVersionId = agentComposeSnapshot.agentComposeVersionId;
  if (!agentComposeVersionId) {
    throw badRequest("Invalid checkpoint: missing agentComposeVersionId");
  }

  // Verify checkpoint belongs to user
  const [originalRun] = await globalThis.services.db
    .select({ runId: agentRuns.id })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.id, checkpoint.runId), eq(agentRuns.userId, userId)),
    )
    .limit(1);

  if (!originalRun) {
    throw unauthorized("Checkpoint does not belong to authenticated user");
  }

  // Run independent queries in parallel:
  // - Conversation → session history chain (needs checkpoint.conversationId)
  // - Compose version lookup (needs snapshot.agentComposeVersionId)
  const [conversationResult, versionResult] = await Promise.all([
    // Conversation → session history (serial chain)
    (async () => {
      const [conversation] = await globalThis.services.db
        .select()
        .from(conversations)
        .where(eq(conversations.id, checkpoint.conversationId))
        .limit(1);

      if (!conversation) {
        throw notFound("Conversation not found");
      }

      const sessionHistory = await resolveSessionHistory(
        conversation.cliAgentSessionHistoryHash,
        conversation.cliAgentSessionHistory,
      );

      return { conversation, sessionHistory };
    })(),
    // Compose version lookup
    globalThis.services.db
      .select()
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, agentComposeVersionId))
      .limit(1),
  ]);

  const { conversation, sessionHistory } = conversationResult;

  const [version] = versionResult;
  if (!version) {
    throw notFound(`Agent compose version ${agentComposeVersionId} not found`);
  }
  const agentCompose = version.content as AgentComposeYaml;
  const workingDir = extractWorkingDir(agentCompose);
  const artifacts = decodeCheckpointArtifacts(rawArtifacts, workingDir);

  return {
    conversationId: checkpoint.conversationId,
    agentComposeVersionId,
    agentCompose,
    workingDir,
    conversationData: {
      cliAgentSessionId: conversation.cliAgentSessionId,
      cliAgentSessionHistory: sessionHistory,
    },
    artifacts,
    vars: agentComposeSnapshot.vars || {},
    volumeVersions: checkpointVolumeVersions?.versions,
    additionalVolumes: checkpointAdditionalVolumes,
  };
}

/**
 * Decode checkpoint.artifactSnapshots into the unified ContextArtifact[] form.
 *
 * Input is a Drizzle `jsonb` column (runtime type `unknown`), so every branch
 * must validate the shape at runtime — a malformed historical row should fail
 * fast here with a descriptive error rather than surface much later as an
 * opaque mount failure.
 *
 * Accepts both shapes:
 * - Legacy: `Record<name, version>` — stamped with a mountPath via the name
 *   heuristic ("memory" → AUTO_MEMORY_MOUNT_PATH, anything else → workingDir).
 * - New: `Array<{name, version?, mountPath}>` — validated and passed through.
 */
function decodeCheckpointArtifacts(
  raw: unknown,
  workingDir: string,
): ContextArtifact[] {
  if (raw === null || raw === undefined) return [];

  if (Array.isArray(raw)) {
    return raw.map((entry, i) => {
      if (!isContextArtifact(entry)) {
        throw badRequest(
          `Invalid checkpoint: artifactSnapshots[${i}] is not a valid ContextArtifact`,
        );
      }
      return entry;
    });
  }

  if (typeof raw !== "object") {
    throw badRequest(
      "Invalid checkpoint: artifactSnapshots must be an array or object",
    );
  }

  return Object.entries(raw as Record<string, unknown>).map(
    ([name, version]) => {
      if (typeof version !== "string") {
        throw badRequest(
          `Invalid checkpoint: artifactSnapshots["${name}"] must be a string version`,
        );
      }
      return {
        name,
        version,
        mountPath:
          name === AUTO_MEMORY_ARTIFACT_NAME
            ? AUTO_MEMORY_MOUNT_PATH
            : workingDir,
      };
    },
  );
}

function isContextArtifact(value: unknown): value is ContextArtifact {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== "string") return false;
  if (typeof entry.mountPath !== "string") return false;
  if (entry.version !== undefined && typeof entry.version !== "string") {
    return false;
  }
  return true;
}
