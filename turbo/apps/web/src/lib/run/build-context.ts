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
 * Model provider environment variables that indicate explicit configuration.
 * Includes both model-provider supported vars and alternative auth methods.
 */
const MODEL_PROVIDER_ENV_VARS = [
  // Model-provider supported
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  // Alternative auth methods (not model-provider supported yet)
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
];

/**
 * Resolve model provider type from explicit value or default
 */
async function resolveProviderType(
  scopeId: string,
  framework: ModelProviderFramework,
  explicitModelProvider?: string,
): Promise<ModelProviderType> {
  if (explicitModelProvider) {
    // Validate that the specified model provider type is valid
    if (!(explicitModelProvider in MODEL_PROVIDER_TYPES)) {
      throw new BadRequestError(
        `Unknown model provider type "${explicitModelProvider}". Valid types: ${Object.keys(MODEL_PROVIDER_TYPES).join(", ")}`,
      );
    }
    return explicitModelProvider as ModelProviderType;
  }

  // Get default provider for framework
  const defaultProvider = await getDefaultModelProvider(scopeId, framework);
  if (!defaultProvider?.type) {
    throw new BadRequestError(
      "No model provider configured. " +
        "Run 'vm0 model-provider setup' to configure one, " +
        "or add environment variables to your vm0.yaml.",
    );
  }
  return defaultProvider.type;
}

/**
 * Result of model provider credential resolution
 */
interface ModelProviderCredentialResult {
  credentials: Record<string, string> | undefined;
  credentialName: string | undefined;
}

/**
 * Resolve and inject model provider credential if needed
 * Only injects if no explicit model provider config in compose environment
 */
async function resolveModelProviderCredential(
  userId: string,
  framework: string,
  hasExplicitModelProviderConfig: boolean,
  existingCredentials: Record<string, string> | undefined,
  explicitModelProvider?: string,
): Promise<ModelProviderCredentialResult> {
  let credentials = existingCredentials;

  // Skip if explicit model provider config exists or framework doesn't use model providers
  if (
    hasExplicitModelProviderConfig ||
    (framework !== "claude-code" && framework !== "codex")
  ) {
    return { credentials, credentialName: undefined };
  }

  const userScope = await getUserScopeByClerkId(userId);
  if (!userScope) {
    return { credentials, credentialName: undefined };
  }

  // Resolve model provider type (explicit or default)
  const providerType = await resolveProviderType(
    userScope.id,
    framework as ModelProviderFramework,
    explicitModelProvider,
  );

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
    log.debug(`Injected model provider credential: ${credentialName}`);
  }

  return { credentials, credentialName };
}

/**
 * Fetch credentials referenced in compose environment
 */
async function fetchReferencedCredentials(
  userId: string,
  environment: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  if (!environment) {
    return undefined;
  }

  const refs = extractVariableReferences(environment);
  const grouped = groupVariablesBySource(refs);

  if (grouped.credentials.length === 0) {
    return undefined;
  }

  log.debug(
    `Credentials referenced in environment: ${grouped.credentials.map((r) => r.name).join(", ")}`,
  );

  const userScope = await getUserScopeByClerkId(userId);
  if (!userScope) {
    return undefined;
  }

  const credentials = await getCredentialValues(userScope.id);
  log.debug(
    `Fetched ${Object.keys(credentials).length} credential(s) from scope ${userScope.slug}`,
  );
  return credentials;
}

/**
 * Auto-inject model provider credential into environment
 * Returns the potentially modified environment
 */
function autoInjectCredentialToEnvironment(
  environment: Record<string, string> | undefined,
  credentialName: string | undefined,
  credentials: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!credentialName || !credentials?.[credentialName]) {
    return environment;
  }

  // Only inject if not already set (user-defined environment takes precedence)
  if (environment?.[credentialName]) {
    return environment;
  }

  const result = environment || {};
  result[credentialName] = credentials[credentialName]!;
  log.debug(
    `Auto-injected model provider credential to environment: ${credentialName}`,
  );
  return result;
}

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
  // Model provider for automatic credential injection
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

  // Extract compose structure
  const compose = agentCompose as {
    agents?: Record<
      string,
      { environment?: Record<string, string>; framework?: string }
    >;
  };
  const firstAgent = compose?.agents
    ? Object.values(compose.agents)[0]
    : undefined;

  // Fetch credentials referenced in environment
  credentials = await fetchReferencedCredentials(
    params.userId,
    firstAgent?.environment,
  );

  // Step 4b: Model provider credential injection
  const hasExplicitModelProviderConfig = MODEL_PROVIDER_ENV_VARS.some(
    (v) => firstAgent?.environment?.[v] !== undefined,
  );
  const framework = firstAgent?.framework || "claude-code";

  const modelProviderResult = await resolveModelProviderCredential(
    params.userId,
    framework,
    hasExplicitModelProviderConfig,
    credentials,
    params.modelProvider,
  );
  credentials = modelProviderResult.credentials;
  const modelProviderCredentialName = modelProviderResult.credentialName;

  // Step 5: Expand environment variables from compose config using vars, secrets, and credentials
  // When experimental_firewall.experimental_seal_secrets is enabled, secrets are encrypted
  const { environment: expandedEnvironment } = expandEnvironmentFromCompose(
    agentCompose,
    vars,
    secrets,
    credentials,
    params.userId,
    params.runId,
  );

  // Step 5b: Auto-inject model provider credential into environment
  const environment = autoInjectCredentialToEnvironment(
    expandedEnvironment,
    modelProviderCredentialName,
    credentials,
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
