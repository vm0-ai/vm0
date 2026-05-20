import { eq } from "drizzle-orm";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  agentComposeVersions,
  agentComposes,
} from "@vm0/db/schema/agent-compose";
import { notFound, unauthorized, badRequest } from "@vm0/api-services/errors";
import { logger } from "../shared/logger";
import type { AgentComposeSnapshot } from "../infra/checkpoint/types";
import type { AgentComposeYaml } from "../infra/agent-compose/types";
import { getAgentSessionWithConversation } from "../infra/agent-session";

const log = logger("service:zero-run-validation");

/**
 * Resolved compose metadata from one of the 4 resolution modes.
 *
 * Includes version content and compose owner so the chat-send path can
 * authorize and build the run without a second DB round-trip.
 *
 * `composeId` is always populated — every resolution path either finds an
 * existing compose (and throws `notFound` otherwise).
 */
interface ResolvedStartRunCompose {
  agentComposeVersionId: string;
  composeId: string;
  composeUserId: string;
  agentName?: string;
  orgId: string;
  composeContent: AgentComposeYaml;
}

/**
 * Validate a checkpoint for resume operation
 * Returns checkpoint data without creating full execution context
 * Note: secrets values are NEVER stored - only names for validation
 *
 * @param checkpointId Checkpoint ID to validate
 * @param userId User ID for authorization check
 * @returns Checkpoint data with agentComposeVersionId, vars, and secretNames
 * @throws NotFoundError if checkpoint doesn't exist
 * @throws UnauthorizedError if checkpoint doesn't belong to user
 */
async function validateCheckpoint(
  checkpointId: string,
  userId: string,
): Promise<{
  agentComposeVersionId: string;
  vars: Record<string, string> | null;
  secretNames: string[] | null;
}> {
  log.debug(`Validating checkpoint ${checkpointId} for user ${userId}`);

  // Load checkpoint with associated run in a single query
  const [result] = await globalThis.services.db
    .select({
      agentComposeSnapshot: checkpoints.agentComposeSnapshot,
      runUserId: agentRuns.userId,
      runVars: agentRuns.vars,
      runSecretNames: agentRuns.secretNames,
    })
    .from(checkpoints)
    .leftJoin(agentRuns, eq(checkpoints.runId, agentRuns.id))
    .where(eq(checkpoints.id, checkpointId))
    .limit(1);

  if (!result) {
    throw notFound("Checkpoint not found");
  }

  // Verify the associated run exists and belongs to user
  if (!result.runUserId) {
    throw notFound("Associated run not found");
  }

  if (result.runUserId !== userId) {
    throw unauthorized("Checkpoint does not belong to authenticated user");
  }

  // Get version ID from snapshot
  const agentComposeSnapshot =
    result.agentComposeSnapshot as unknown as AgentComposeSnapshot;

  const agentComposeVersionId = agentComposeSnapshot.agentComposeVersionId;
  if (!agentComposeVersionId) {
    throw badRequest("Invalid checkpoint: missing agentComposeVersionId");
  }

  log.debug(
    `Checkpoint validated: agentComposeVersionId=${agentComposeVersionId}`,
  );

  // Get vars from original run, secretNames from run (values are NEVER stored)
  const vars = (result.runVars as Record<string, string>) ?? null;
  const secretNames = (result.runSecretNames as string[]) ?? null;

  return {
    agentComposeVersionId,
    vars,
    secretNames,
  };
}

/**
 * Validate an agent session for continue operation
 * Returns session data without creating full execution context
 * Note: secrets values are NEVER stored - only names for validation
 *
 * @param agentSessionId Agent session ID to validate
 * @param userId User ID for authorization check
 * @returns Session data with agentComposeId
 * @throws NotFoundError if session doesn't exist
 * @throws UnauthorizedError if session doesn't belong to user
 */
async function validateAgentSession(
  agentSessionId: string,
  userId: string,
): Promise<{
  agentComposeId: string;
}> {
  log.debug(`Validating agent session ${agentSessionId} for user ${userId}`);

  // Load session with conversation data
  const session = await getAgentSessionWithConversation(agentSessionId);

  if (!session) {
    throw notFound("Agent session not found");
  }

  // Verify session belongs to user
  if (session.userId !== userId) {
    throw unauthorized("Agent session does not belong to authenticated user");
  }

  // Session must have a conversation to continue from
  if (!session.conversation) {
    throw notFound(
      "Agent session has no conversation history to continue from",
    );
  }

  log.debug(`Session validated: agentComposeId=${session.agentComposeId}`);

  return {
    agentComposeId: session.agentComposeId,
  };
}

/**
 * Look up compose metadata + version content from a version ID (shared by
 * checkpoint + versionId paths). Single LEFT JOIN. Throws `notFound` if
 * the version row is missing or its parent compose row has been deleted.
 */
async function lookupComposeByVersion(versionId: string): Promise<{
  composeId: string;
  composeUserId: string;
  agentName?: string;
  orgId: string;
  composeContent: AgentComposeYaml;
}> {
  const [row] = await globalThis.services.db
    .select({
      versionContent: agentComposeVersions.content,
      composeName: agentComposes.name,
      composeOrgId: agentComposes.orgId,
      composeId: agentComposes.id,
      composeUserId: agentComposes.userId,
    })
    .from(agentComposeVersions)
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);

  if (!row || !row.composeId || !row.composeOrgId) {
    throw notFound("Agent compose version not found");
  }

  return {
    composeId: row.composeId,
    composeUserId: row.composeUserId ?? "",
    agentName: row.composeName ?? undefined,
    orgId: row.composeOrgId,
    composeContent: row.versionContent as AgentComposeYaml,
  };
}

/**
 * Resolve compose by composeId → headVersionId + content in a single JOIN.
 *
 * LEFT JOIN on head_version_id so we can distinguish "compose missing"
 * (notFound) from "compose has no head version" (badRequest).
 */
async function resolveByComposeId(
  composeId: string,
): Promise<ResolvedStartRunCompose> {
  const [row] = await globalThis.services.db
    .select({
      composeId: agentComposes.id,
      composeName: agentComposes.name,
      composeOrgId: agentComposes.orgId,
      composeUserId: agentComposes.userId,
      headVersionId: agentComposes.headVersionId,
      versionId: agentComposeVersions.id,
      versionContent: agentComposeVersions.content,
    })
    .from(agentComposes)
    .leftJoin(
      agentComposeVersions,
      eq(agentComposeVersions.id, agentComposes.headVersionId),
    )
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!row) {
    throw notFound("Agent compose not found");
  }
  if (!row.headVersionId || !row.versionId) {
    throw badRequest("Agent compose has no versions. Run 'vm0 build' first.");
  }

  return {
    agentComposeVersionId: row.versionId,
    composeId: row.composeId,
    composeUserId: row.composeUserId,
    agentName: row.composeName || undefined,
    orgId: row.composeOrgId,
    composeContent: row.versionContent as AgentComposeYaml,
  };
}

/**
 * Resolve compose version + org ID from StartRunParams.
 *
 * Handles 4 mutually exclusive resolution modes:
 * 1. checkpointId → validate checkpoint → get version, then look up compose
 * 2. sessionId → validate session → get compose → use headVersionId
 * 3. agentComposeVersionId → use directly, look up compose metadata
 * 4. composeId → load compose → use headVersionId
 */
export async function resolveStartRunCompose(params: {
  userId: string;
  prompt?: string;
  composeId?: string;
  agentComposeVersionId?: string;
  checkpointId?: string;
  sessionId?: string;
}): Promise<ResolvedStartRunCompose> {
  // Validate mutual exclusivity before resolution
  if (params.checkpointId && params.sessionId) {
    throw badRequest(
      "Cannot specify both checkpointId and sessionId. Use one or the other.",
    );
  }

  if (params.checkpointId) {
    const checkpointData = await validateCheckpoint(
      params.checkpointId,
      params.userId,
    );
    const meta = await lookupComposeByVersion(
      checkpointData.agentComposeVersionId,
    );
    return {
      agentComposeVersionId: checkpointData.agentComposeVersionId,
      ...meta,
    };
  }

  if (params.sessionId) {
    const sessionData = await validateAgentSession(
      params.sessionId,
      params.userId,
    );
    return resolveByComposeId(sessionData.agentComposeId);
  }

  if (params.agentComposeVersionId) {
    const meta = await lookupComposeByVersion(params.agentComposeVersionId);
    return { agentComposeVersionId: params.agentComposeVersionId, ...meta };
  }

  if (!params.composeId) {
    throw badRequest(
      "Missing agentComposeId or agentComposeVersionId. Provide composeId, agentComposeVersionId, checkpointId, or sessionId.",
    );
  }

  return resolveByComposeId(params.composeId);
}
