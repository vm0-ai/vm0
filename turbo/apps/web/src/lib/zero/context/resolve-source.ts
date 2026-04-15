import { eq } from "drizzle-orm";
import {
  areProvidersCompatible,
  MODEL_PROVIDER_TYPES,
  type ModelProviderType,
} from "@vm0/core";
import {
  agentComposeVersions,
  agentComposes,
} from "../../../db/schema/agent-compose";
import { getAgentSessionWithConversation } from "../../infra/agent-session";
import { checkpoints } from "../../../db/schema/checkpoint";
import { agentRuns } from "../../../db/schema/agent-run";
import {
  badRequest,
  notFound,
  providerIncompatible,
} from "../../shared/errors";
import { logger } from "../../shared/logger";
import type { ResumeSession } from "../../infra/run/types";
import type { ArtifactSnapshot } from "../../infra/checkpoint/types";
import type { AdditionalVolume } from "../../infra/storage/types";
import {
  resolveCheckpoint,
  resolveSession,
  resolveDirectConversation,
  type ConversationResolution,
} from "../../infra/run/resolvers";

const log = logger("zero:build-context");

/**
 * Narrow input type for resolveSource — only the fields needed for source resolution.
 */
interface ResolveSourceParams {
  checkpointId?: string;
  sessionId?: string;
  conversationId?: string;
  agentComposeVersionId?: string;
  userId: string;
}

/**
 * Resolve source based on params
 * Returns ConversationResolution if a source is found, null for new runs
 */
export async function resolveSource(
  params: ResolveSourceParams,
): Promise<ConversationResolution | null> {
  if (params.checkpointId) {
    log.debug(`Resolving checkpoint ${params.checkpointId}`);
    return resolveCheckpoint(params.checkpointId, params.userId);
  }

  if (params.sessionId) {
    log.debug(`Resolving session ${params.sessionId}`);
    return resolveSession(params.sessionId, params.userId);
  }

  if (params.conversationId && params.agentComposeVersionId) {
    log.debug(`Resolving conversation ${params.conversationId}`);
    return resolveDirectConversation(
      params.conversationId,
      params.agentComposeVersionId,
      params.userId,
    );
  }

  return null;
}

/**
 * Load agent compose for new runs (no resolution)
 */
export async function loadAgentComposeForNewRun(
  agentComposeVersionId: string,
): Promise<unknown> {
  const [version] = await globalThis.services.db
    .select()
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, agentComposeVersionId))
    .limit(1);

  if (!version) {
    throw notFound("Agent compose version not found");
  }

  return version.content;
}

/**
 * Verify the caller's org has access to the session or checkpoint being resumed.
 * Must run BEFORE full source resolution to prevent leaking cross-org details
 * (e.g., framework mismatch errors).
 */
export async function verifyOrgAccessForResume(params: {
  sessionId?: string;
  checkpointId?: string;
  userId: string;
  orgId: string;
}): Promise<void> {
  if (params.sessionId) {
    const session = await getAgentSessionWithConversation(params.sessionId);
    if (!session || session.userId !== params.userId) {
      throw notFound("Resource not found");
    }
    const [compose] = await globalThis.services.db
      .select({ orgId: agentComposes.orgId })
      .from(agentComposes)
      .where(eq(agentComposes.id, session.agentComposeId))
      .limit(1);
    if (!compose || compose.orgId !== params.orgId) {
      throw notFound("Resource not found");
    }
  } else if (params.checkpointId) {
    const [cp] = await globalThis.services.db
      .select({ orgId: agentRuns.orgId })
      .from(checkpoints)
      .innerJoin(agentRuns, eq(checkpoints.runId, agentRuns.id))
      .where(eq(checkpoints.id, params.checkpointId))
      .limit(1);
    if (!cp || cp.orgId !== params.orgId) {
      throw notFound("Resource not found");
    }
  }
}

/**
 * Resolve agentComposeVersionId from a composeId (head version lookup).
 * Verifies compose exists and belongs to the caller's org.
 */
export async function resolveComposeFromId(
  composeId: string,
  orgId: string,
): Promise<string> {
  const [compose] = await globalThis.services.db
    .select({
      headVersionId: agentComposes.headVersionId,
      orgId: agentComposes.orgId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  if (!compose) {
    throw notFound("Agent compose not found");
  }
  if (compose.orgId !== orgId) {
    throw notFound("Resource not found");
  }
  if (!compose.headVersionId) {
    throw badRequest("Agent compose has no versions. Run 'vm0 build' first.");
  }
  return compose.headVersionId;
}

/**
 * Check that the resolved model provider is compatible with the original
 * provider from the session being continued.
 */
export function checkProviderCompatibility(
  originalModelProvider: string | undefined,
  resolvedModelProvider: ModelProviderType | undefined,
): void {
  if (
    originalModelProvider &&
    resolvedModelProvider &&
    originalModelProvider in MODEL_PROVIDER_TYPES
  ) {
    const originalType = originalModelProvider as ModelProviderType;
    const newType = resolvedModelProvider as ModelProviderType;
    if (!areProvidersCompatible(originalType, newType)) {
      const originalLabel = MODEL_PROVIDER_TYPES[originalType].label;
      const newLabel = MODEL_PROVIDER_TYPES[newType].label;
      throw providerIncompatible(
        `Cannot continue session: this session was created with ${originalLabel} and cannot be continued with ${newLabel}. ` +
          `Please start a new session or switch back to a compatible model.`,
      );
    }
  }
}

/**
 * Parameters for applyResolutionDefaults — only the fields it needs from the caller.
 */
interface ApplyResolutionDefaultsParams {
  agentComposeVersionId?: string;
  artifactName?: string;
  artifactVersion?: string;
  memoryName?: string;
  vars?: Record<string, string>;
  volumeVersions?: Record<string, string>;
  additionalVolumes?: AdditionalVolume[];
}

/**
 * Apply resolution defaults to context variables.
 * Params override resolution values (explicit CLI args win).
 */
export function applyResolutionDefaults(
  params: ApplyResolutionDefaultsParams,
  resolution: ConversationResolution,
): {
  agentComposeVersionId: string;
  agentCompose: unknown;
  artifactName: string | undefined;
  artifactVersion: string | undefined;
  memoryName: string | undefined;
  vars: Record<string, string> | undefined;
  volumeVersions: Record<string, string> | undefined;
  additionalVolumes: AdditionalVolume[] | undefined;
  resumeSession: ResumeSession;
  resumeArtifact: ArtifactSnapshot | undefined;
} {
  const artifactName = params.artifactName || resolution.artifactName;
  const artifactVersion = params.artifactVersion || resolution.artifactVersion;

  // Build resumeArtifact if applicable
  let resumeArtifact: ArtifactSnapshot | undefined;
  if (resolution.buildResumeArtifact && artifactName) {
    resumeArtifact = {
      artifactName,
      artifactVersion: artifactVersion || "latest",
    };
  }

  return {
    agentComposeVersionId:
      params.agentComposeVersionId || resolution.agentComposeVersionId,
    agentCompose: resolution.agentCompose,
    artifactName,
    artifactVersion,
    memoryName: params.memoryName || resolution.memoryName,
    vars: params.vars || resolution.vars,
    volumeVersions: params.volumeVersions || resolution.volumeVersions,
    additionalVolumes: params.additionalVolumes || resolution.additionalVolumes,
    resumeSession: {
      sessionId: resolution.conversationData.cliAgentSessionId,
      sessionHistory: resolution.conversationData.cliAgentSessionHistory,
      workingDir: resolution.workingDir,
    },
    resumeArtifact,
  };
}
