import { eq } from "drizzle-orm";
import { checkpoints } from "../../db/schema/checkpoint";
import { agentRuns } from "../../db/schema/agent-run";
import {
  agentComposeVersions,
  agentComposes,
} from "../../db/schema/agent-compose";
import { notFound, unauthorized, badRequest } from "../shared/errors";
import { logger } from "../shared/logger";
import type { AgentComposeSnapshot } from "../infra/checkpoint/types";
import { getAgentSessionWithConversation } from "../infra/agent-session";

const log = logger("service:zero-run-validation");

/**
 * Resolved compose metadata from one of the 4 resolution modes.
 */
interface ResolvedStartRunCompose {
  agentComposeVersionId: string;
  composeId?: string;
  agentName?: string;
  orgId: string;
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
export async function validateAgentSession(
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
 * Look up compose metadata from a version ID (shared by checkpoint + versionId paths).
 */
async function lookupComposeByVersion(
  versionId: string,
  fallbackComposeId?: string,
): Promise<{ composeId?: string; agentName?: string; orgId: string }> {
  const [row] = await globalThis.services.db
    .select({
      composeName: agentComposes.name,
      composeOrgId: agentComposes.orgId,
      composeId: agentComposes.id,
    })
    .from(agentComposeVersions)
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);

  return {
    composeId: row?.composeId ?? fallbackComposeId,
    agentName: row?.composeName ?? undefined,
    orgId: row?.composeOrgId ?? "",
  };
}

/**
 * Resolve compose by composeId → headVersionId.
 */
async function resolveByComposeId(
  composeId: string,
): Promise<ResolvedStartRunCompose> {
  const [compose] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      orgId: agentComposes.orgId,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose) {
    throw notFound("Agent compose not found");
  }
  if (!compose.headVersionId) {
    throw badRequest("Agent compose has no versions. Run 'vm0 build' first.");
  }

  return {
    agentComposeVersionId: compose.headVersionId,
    composeId: compose.id,
    agentName: compose.name ?? undefined,
    orgId: compose.orgId,
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
    if (!meta.orgId) {
      throw notFound("Agent compose version not found");
    }
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
    const meta = await lookupComposeByVersion(
      params.agentComposeVersionId,
      params.composeId,
    );
    if (!meta.orgId) {
      throw notFound("Agent compose version not found");
    }
    return { agentComposeVersionId: params.agentComposeVersionId, ...meta };
  }

  if (!params.composeId) {
    throw badRequest(
      "Missing agentComposeId or agentComposeVersionId. Provide composeId, agentComposeVersionId, checkpointId, or sessionId.",
    );
  }

  return resolveByComposeId(params.composeId);
}
