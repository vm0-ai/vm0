import { eq } from "drizzle-orm";
import { agentComposeVersions } from "../../db/schema/agent-compose";
import { NotFoundError } from "../errors";
import { logger } from "../logger";
import type { ExecutionContext, ResumeSession } from "./types";
import type { ArtifactSnapshot } from "../checkpoint/types";
import {
  resolveCheckpoint,
  resolveSession,
  resolveDirectConversation,
  type ConversationResolution,
} from "./resolvers";
import { expandEnvironmentFromCompose } from "./environment";

const log = logger("run:build-context");

/**
 * Parameters for building execution context
 */
export interface BuildContextParams {
  // Shortcuts (mutually exclusive)
  checkpointId?: string;
  sessionId?: string;
  // Base parameters
  agentComposeVersionId?: string;
  conversationId?: string;
  artifactName?: string;
  artifactVersion?: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  volumeVersions?: Record<string, string>;
  // Required
  prompt: string;
  runId: string;
  sandboxToken: string;
  userId: string;
  // Metadata for vm0_start event
  agentName?: string;
  resumedFromCheckpointId?: string;
  continuedFromSessionId?: string;
}

/**
 * Resolve source based on params
 * Returns ConversationResolution if a source is found, null for new runs
 */
async function resolveSource(
  params: BuildContextParams,
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
async function loadAgentComposeForNewRun(
  agentComposeVersionId: string,
): Promise<unknown> {
  const [version] = await globalThis.services.db
    .select()
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, agentComposeVersionId))
    .limit(1);

  if (!version) {
    throw new NotFoundError("Agent compose version not found");
  }

  return version.content;
}

/**
 * Build unified execution context from various parameter sources
 * Supports: new run, checkpoint resume, session continue
 *
 * Parameter expansion:
 * - checkpointId: Expands to checkpoint snapshot (config, conversation, artifact, volumes)
 * - sessionId: Expands to session data (config, conversation, artifact=latest)
 * - Explicit parameters override expanded values
 *
 * @param params Unified run parameters
 * @returns Execution context for executors
 */
export async function buildExecutionContext(
  params: BuildContextParams,
): Promise<ExecutionContext> {
  log.debug(`Building execution context for ${params.runId}`);
  log.debug(`params.volumeVersions=${JSON.stringify(params.volumeVersions)}`);

  // Initialize context variables
  let agentComposeVersionId: string | undefined = params.agentComposeVersionId;
  let agentCompose: unknown;
  let artifactName: string | undefined = params.artifactName;
  let artifactVersion: string | undefined = params.artifactVersion;
  let vars: Record<string, string> | undefined = params.vars;
  const secrets: Record<string, string> | undefined = params.secrets;
  let secretNames: string[] | undefined;
  let volumeVersions: Record<string, string> | undefined =
    params.volumeVersions;
  let resumeSession: ResumeSession | undefined;
  let resumeArtifact: ArtifactSnapshot | undefined;

  // Step 1: Resolve to conversation (unified path for checkpoint/session/direct)
  const resolution = await resolveSource(params);

  // Step 2: Apply resolution defaults and build resumeSession (unified path)
  // Note: secrets are NEVER stored - caller must always provide fresh secrets via params
  if (resolution) {
    // Apply defaults (params override resolution values)
    agentComposeVersionId =
      agentComposeVersionId || resolution.agentComposeVersionId;
    agentCompose = resolution.agentCompose;
    artifactName = artifactName || resolution.artifactName;
    artifactVersion = artifactVersion || resolution.artifactVersion;
    vars = vars || resolution.vars;
    // secrets from params only - resolution only has secretNames for validation
    // Get secretNames from resolution (stored for validation/error messages)
    secretNames = resolution.secretNames;
    volumeVersions = volumeVersions || resolution.volumeVersions;

    // Build resumeSession from resolution (single place!)
    resumeSession = {
      sessionId: resolution.conversationData.cliAgentSessionId,
      sessionHistory: resolution.conversationData.cliAgentSessionHistory,
      workingDir: resolution.workingDir,
    };

    // Build resumeArtifact if applicable
    if (resolution.buildResumeArtifact && artifactName) {
      resumeArtifact = {
        artifactName,
        artifactVersion: artifactVersion || "latest",
      };
    }

    log.debug(
      `Resolution applied: artifact=${artifactName}@${artifactVersion}`,
    );
  }
  // Step 3: New run - load agent compose version if agentComposeVersionId provided (no conversation)
  else if (agentComposeVersionId) {
    agentCompose = await loadAgentComposeForNewRun(agentComposeVersionId);

    // For new runs, derive secretNames from provided secrets
    if (secrets) {
      secretNames = Object.keys(secrets);
    }
  }

  // Validate required fields
  if (!agentComposeVersionId) {
    throw new NotFoundError(
      "Agent compose version ID is required (provide agentComposeVersionId, checkpointId, or sessionId)",
    );
  }

  if (!agentCompose) {
    throw new NotFoundError("Agent compose could not be loaded");
  }

  // Step 4: Expand environment variables from compose config using vars and secrets
  // When experimental_firewall.experimental_seal_secrets is enabled, secrets are encrypted
  const { environment } = expandEnvironmentFromCompose(
    agentCompose,
    vars,
    secrets,
    params.userId,
    params.runId,
  );

  // Build final execution context
  return {
    runId: params.runId,
    userId: params.userId,
    agentComposeVersionId,
    agentCompose,
    prompt: params.prompt,
    vars,
    secrets,
    secretNames,
    sandboxToken: params.sandboxToken,
    artifactName,
    artifactVersion,
    volumeVersions,
    environment,
    resumeSession,
    resumeArtifact,
    // Metadata for vm0_start event
    agentName: params.agentName,
    resumedFromCheckpointId: params.resumedFromCheckpointId,
    continuedFromSessionId: params.continuedFromSessionId,
  };
}
