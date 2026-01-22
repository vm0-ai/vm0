import { eq } from "drizzle-orm";
import {
  extractVariableReferences,
  groupVariablesBySource,
  getFrameworkForType,
  getCredentialNameForType,
  MODEL_PROVIDER_TYPES,
  type ModelProviderType,
  type ModelProviderFramework,
} from "@vm0/core";
import { agentComposeVersions } from "../../db/schema/agent-compose";
import { BadRequestError, NotFoundError } from "../errors";
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
import { getUserScopeByClerkId } from "../scope/scope-service";
import {
  getCredentialValue,
  getCredentialValues,
} from "../credential/credential-service";
import { getDefaultModelProvider } from "../model-provider/model-provider-service";

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
  // Debug flag to force real Claude in mock environments (internal use only)
  debugNoMockClaude?: boolean;
  // Model provider for automatic LLM credential injection
  modelProvider?: string;
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
// eslint-disable-next-line complexity -- TODO: refactor complex function
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

  // Step 4: Check if credentials are needed and fetch them from the user's scope
  let credentials: Record<string, string> | undefined;

  // Extract variable references from compose to check for credentials
  const compose = agentCompose as {
    agents?: Record<
      string,
      { environment?: Record<string, string>; framework?: string }
    >;
  };
  if (compose?.agents) {
    const agents = Object.values(compose.agents);
    const firstAgent = agents[0];
    if (firstAgent?.environment) {
      const refs = extractVariableReferences(firstAgent.environment);
      const grouped = groupVariablesBySource(refs);

      // If credentials are referenced, fetch them from the user's scope
      if (grouped.credentials.length > 0) {
        log.debug(
          `Credentials referenced in environment: ${grouped.credentials.map((r) => r.name).join(", ")}`,
        );

        const userScope = await getUserScopeByClerkId(params.userId);
        if (userScope) {
          credentials = await getCredentialValues(userScope.id);
          log.debug(
            `Fetched ${Object.keys(credentials).length} credential(s) from scope ${userScope.slug}`,
          );
        }
      }
    }

    // Step 4b: Model provider credential injection
    // Only inject if no explicit LLM config in compose environment
    const LLM_ENV_VARS = [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "OPENAI_API_KEY",
    ];

    const hasExplicitLLMConfig = LLM_ENV_VARS.some(
      (v) => firstAgent?.environment?.[v] !== undefined,
    );

    if (!hasExplicitLLMConfig) {
      const framework = (firstAgent?.framework || "claude-code") as
        | ModelProviderFramework
        | "aider";

      // Skip model provider injection for frameworks that don't use it
      if (framework === "claude-code" || framework === "codex") {
        const userScope = await getUserScopeByClerkId(params.userId);

        if (userScope) {
          // Resolve model provider (explicit or default)
          let providerType: ModelProviderType | undefined;

          if (params.modelProvider) {
            // Validate that the specified model provider type is valid
            if (!(params.modelProvider in MODEL_PROVIDER_TYPES)) {
              throw new BadRequestError(
                `Unknown model provider type "${params.modelProvider}". Valid types: ${Object.keys(MODEL_PROVIDER_TYPES).join(", ")}`,
              );
            }
            providerType = params.modelProvider as ModelProviderType;
          } else {
            // Get default provider for framework
            const defaultProvider = await getDefaultModelProvider(
              userScope.id,
              framework,
            );
            providerType = defaultProvider?.type;
          }

          if (providerType) {
            // Validate framework compatibility
            const providerFramework = getFrameworkForType(providerType);
            if (providerFramework !== framework) {
              throw new BadRequestError(
                `Model provider "${providerType}" is not compatible with framework "${framework}". ` +
                  `This provider is for "${providerFramework}" agents.`,
              );
            }

            // Get credential and inject
            const credentialName = getCredentialNameForType(providerType);
            const credentialValue = await getCredentialValue(
              userScope.id,
              credentialName,
            );

            if (credentialValue) {
              credentials = credentials || {};
              credentials[credentialName] = credentialValue;
              log.debug(
                `Injected model provider credential: ${credentialName}`,
              );
            }
          } else {
            // No model provider configured - throw helpful error
            throw new BadRequestError(
              "No LLM configuration found. " +
                "Run 'vm0 model-provider setup' to configure a model provider, " +
                "or add environment variables to your vm0.yaml.",
            );
          }
        }
      }
    }
  }

  // Step 5: Expand environment variables from compose config using vars, secrets, and credentials
  // When experimental_firewall.experimental_seal_secrets is enabled, secrets are encrypted
  const { environment } = expandEnvironmentFromCompose(
    agentCompose,
    vars,
    secrets,
    credentials,
    params.userId,
    params.runId,
  );

  // Step 6: Merge credentials into secrets for client-side log masking
  // Credentials are server-stored user-level secrets and must be masked like CLI secrets
  // Priority: CLI --secrets > credentials (platform-stored)
  const mergedSecrets = credentials ? { ...credentials, ...secrets } : secrets;

  // Build final execution context
  return {
    runId: params.runId,
    userId: params.userId,
    agentComposeVersionId,
    agentCompose,
    prompt: params.prompt,
    vars,
    secrets: mergedSecrets,
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
    // Debug flag
    debugNoMockClaude: params.debugNoMockClaude,
  };
}
