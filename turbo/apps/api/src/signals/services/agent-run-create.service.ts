import { command, type Getter } from "ccstate";
import {
  DEFAULT_PROFILE,
  type SecretConnectorMetadata,
  type StorageManifest,
  type StoredExecutionContext,
} from "@vm0/api-contracts/contracts/runners";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import {
  getDefaultModel,
  getModelProviderFirewall,
  getEnvironmentMapping,
  getFrameworkForType,
  getProviderRuntimeModel,
  getSecretNameForType,
  getSecretsForAuthMethod,
  getVm0ConcreteProviderType,
  getVm0Vendor,
  hasAuthMethods,
  MODEL_PROVIDER_TYPES,
  type ModelProviderCredentialScope,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  deriveApiTokenConnectedTypes,
  getConnectorEnvironmentMapping,
  getConnectorProvidedSecretNames,
} from "@vm0/connectors/connector-utils";
import {
  connectorTypeSchema,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  BILLABLE_CONNECTORS,
  getConnectorFirewall,
  isFirewallConnectorType,
} from "@vm0/connectors/firewalls";
import { PROVIDER_HANDLERS } from "@vm0/connectors/oauth-providers";
import {
  expandHostWildcardsInBaseUrl,
  resolveFirewallBaseUrlVars,
  type ExpandedFirewallConfig,
  type FirewallPolicies,
  type Firewalls,
  type NetworkPolicies,
} from "@vm0/connectors/firewall-types";
import {
  type CreateRunResponse,
  type RunStatus,
  unifiedRunRequestSchema,
} from "@vm0/api-contracts/contracts/runs";
import {
  isSupportedFramework,
  type SupportedFramework,
} from "@vm0/core/frameworks";
import { MOUNT_PATH_TEMPLATE } from "@vm0/api-contracts/contracts/composes";
import { resolveSkillRef, parseGitHubTreeUrl } from "@vm0/core/github-url";
import {
  getCustomSkillStorageName,
  getSkillStorageName,
} from "@vm0/core/storage-names";
import { SEED_SKILLS } from "@vm0/core/zero-seed-skills";
import {
  expandVariables,
  extractAndGroupVariables,
} from "@vm0/core/variable-expander";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { connectors } from "@vm0/db/schema/connector";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { conversations } from "@vm0/db/schema/conversation";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { secrets as secretsTable } from "@vm0/db/schema/secret";
import { userCache } from "@vm0/db/schema/user-cache";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { variables } from "@vm0/db/schema/variable";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, count, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import {
  badRequestMessage,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { writeDb$, type Db } from "../external/db";
import { downloadS3Buffer } from "../external/s3";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import {
  publishOrgSignal,
  publishRunChangedForUserSafely,
} from "../external/realtime";
import { now, nowDate } from "../external/time";
import { generateZeroToken } from "../auth/tokens";
import { safeAsync } from "../utils";
import {
  decryptSecretValue,
  encryptSecretValue,
  encryptSecretsMap,
} from "./crypto.utils";
import { prepareAgentRunStorageManifest } from "./agent-run-storage.service";
import {
  encryptQueuedRunnerJobPayload,
  queuedRunnerJobPayload,
} from "./agent-run-queue-payload.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { dispatchRunCallbacks } from "./agent-run-callback.service";
import { drainOrgQueue$ } from "./zero-run-queue.service";
import { notifyRunnerJob } from "./runner-dispatch.service";
import { logger } from "../../lib/log";

const PENDING_RUN_TTL_MS = 15 * 60 * 1000;
const QUEUED_RUN_TTL_MS = 2 * 60 * 60 * 1000;
const AUTO_MEMORY_ARTIFACT_NAME = "memory";
const AUTO_MEMORY_MOUNT_PATH =
  "/home/user/.claude/projects/-home-user-workspace/memory";
const CODEX_AUTO_MEMORY_MOUNT_PATH = "/home/user/.codex/memories";

const TIER_LIMITS = Object.freeze({
  free: 1,
  pro: 2,
  team: 10,
});

const ORG_SENTINEL_USER_ID = "__org__";
const CUSTOM_CONNECTOR_SECRET_PLACEHOLDER = "{{secret}}";
const PLATFORM_ENV_SECRET_NAMES = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
] as const;
const L = logger("AgentRunCreate");

type CreateRunBody = z.infer<typeof unifiedRunRequestSchema>;
type ComputedGetter = Getter;

function withZeroTokenSecret(
  body: CreateRunBody,
  zeroToken: string,
): CreateRunBody {
  return {
    ...body,
    secrets: {
      ...body.secrets,
      ZERO_TOKEN: zeroToken,
    },
  };
}

function withPendingZeroTokenSecret(body: CreateRunBody): CreateRunBody {
  return withZeroTokenSecret(body, "__pending_zero_token__");
}

interface ContextArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
}

interface ComposeArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mount_path?: string;
}

interface AdditionalVolume {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly system?: boolean;
}

interface ZeroRunMetadata {
  readonly triggerAgentId?: string;
  readonly scheduleId?: string;
}

interface AgentConfig {
  readonly framework?: string;
  readonly environment?: Record<string, string>;
  readonly experimental_runner?: { readonly group?: string };
  readonly experimental_profile?: string;
}

interface AgentComposeContent {
  readonly agent?: AgentConfig;
  readonly agents?: Record<string, AgentConfig | undefined>;
  readonly artifacts?: readonly ComposeArtifact[];
}

interface ResolvedCompose {
  readonly agentComposeVersionId: string;
  readonly composeId: string;
  readonly composeUserId: string;
  readonly orgId: string;
  readonly agentName?: string;
  readonly content: AgentComposeContent;
  readonly artifacts: readonly ContextArtifact[];
  readonly volumeVersions?: Record<string, string>;
  readonly additionalVolumes?: readonly AdditionalVolume[];
  readonly sessionId?: string;
  readonly resumedFromCheckpointId?: string;
  readonly continuedFromSessionId?: string;
  readonly resumeSession?: StoredExecutionContext["resumeSession"];
}

interface RunRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly sessionId: string;
  readonly status: "pending" | "queued";
}

interface RunCallback {
  readonly url: string;
  readonly secret: string;
  readonly payload: unknown;
}

interface ResolvedModelProviderEnvironment {
  readonly id: string | null;
  readonly type: ModelProviderType;
  readonly concreteType?: ModelProviderType;
  readonly environment: Record<string, string>;
  readonly secrets: Record<string, string>;
  readonly selectedModel: string | null;
  readonly secretConnectorMap?: Record<string, string>;
  readonly secretConnectorMetadataMap?: Record<string, SecretConnectorMetadata>;
}

interface PermissionManifest {
  readonly firewalls: Firewalls;
  readonly networkPolicies: NetworkPolicies;
}

interface StoredExecutionSecrets {
  readonly secrets: Record<string, string> | undefined;
  readonly secretConnectorMap: Record<string, string> | null;
  readonly secretConnectorMetadataMap: Record<
    string,
    SecretConnectorMetadata
  > | null;
}

interface BuiltStoredExecutionContext {
  readonly context: StoredExecutionContext;
  readonly secretNames: readonly string[];
  readonly secretValues: readonly string[];
}

type RunContextSnapshot = Omit<RunContextResponse, "vars"> & {
  readonly userId: string;
};

type ApiErrorResponse<Status extends number, Code extends string> = {
  readonly status: Status;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: Code;
    };
  };
};

type CreateRunRouteResult =
  | { readonly status: 201; readonly body: CreateRunResponse }
  | ApiErrorResponse<400, "BAD_REQUEST">
  | ApiErrorResponse<403, "FORBIDDEN">
  | ApiErrorResponse<404, "NOT_FOUND">
  | ApiErrorResponse<402, "INSUFFICIENT_CREDITS">
  | ApiErrorResponse<429, "CONCURRENT_RUN_LIMIT">
  | ApiErrorResponse<503, "PROVIDER_UNAVAILABLE">;

type CreateRunErrorResult = Exclude<
  CreateRunRouteResult,
  { readonly status: 201 }
>;

interface CreateAgentRunArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly body: CreateRunBody;
  readonly apiStartTime: number;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly modelProviderType?: string;
  readonly selectedModelOverride?: string;
  readonly callbacks?: readonly RunCallback[];
  readonly chatThreadId?: string;
  readonly includeZeroTokenSecret?: boolean;
  readonly extraEnvironment?: Record<string, string>;
  // When set, system + custom skill volumes are built and prepended in
  // prepareRunContext using the run's resolved (model-provider) framework.
  readonly injectSkillVolumes?: {
    readonly customSkills: readonly string[];
  };
  readonly allowedConnectorTypes?: readonly ConnectorType[];
  readonly allowedCustomConnectorIds?: readonly string[];
  readonly validateEnvironmentReferences?: boolean;
  readonly zeroRunMetadata?: ZeroRunMetadata;
  readonly queueOnConcurrencyLimit?: boolean;
  readonly enforceVm0Credits?: boolean;
}

interface ConnectorRuntimeContext {
  readonly secrets: Record<string, string> | undefined;
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly connectorTypes: readonly ConnectorType[];
}

interface CreditCheckRow extends Record<string, unknown> {
  readonly credit_enabled: boolean | null;
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
}

interface CustomConnectorRuntimeContext {
  readonly firewalls: readonly ExpandedFirewallConfig[];
  readonly secrets: Record<string, string> | undefined;
}

function forbidden(message: string): ApiErrorResponse<403, "FORBIDDEN"> {
  return {
    status: 403,
    body: { error: { message, code: "FORBIDDEN" } },
  };
}

function insufficientCredits(): ApiErrorResponse<402, "INSUFFICIENT_CREDITS"> {
  return {
    status: 402,
    body: {
      error: {
        message: "Insufficient credits. Please add credits to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    },
  };
}

function concurrentRunLimit(): ApiErrorResponse<429, "CONCURRENT_RUN_LIMIT"> {
  return {
    status: 429,
    body: {
      error: {
        message: "Concurrent run limit reached",
        code: "CONCURRENT_RUN_LIMIT",
      },
    },
  };
}

function mergeAdditionalVolumes(args: {
  readonly prepend: readonly AdditionalVolume[] | undefined;
  readonly base: readonly AdditionalVolume[] | undefined;
}): readonly AdditionalVolume[] | undefined {
  return args.prepend || args.base
    ? [...(args.prepend ?? []), ...(args.base ?? [])]
    : undefined;
}

function frameworkSkillsMountPath(framework: SupportedFramework): string {
  return framework === "codex"
    ? "/home/user/.codex/skills"
    : "/home/user/.claude/skills";
}

function skillMountPath(
  framework: SupportedFramework,
  skillName: string,
): string {
  return `${frameworkSkillsMountPath(framework)}/${skillName}`;
}

// Skill volume mount paths are framework-specific. The framework MUST be the
// one resolved from the model provider (see prepareRunContext), never the one
// declared in the compose — a run can execute on a provider whose framework
// differs from the compose, and skills mounted at the wrong path are invisible
// to the agent.
function buildSystemSkillVolumes(
  connectorTypes: readonly ConnectorType[],
  framework: SupportedFramework,
): readonly AdditionalVolume[] {
  const allSkillNames = [...new Set([...SEED_SKILLS, ...connectorTypes])];
  return allSkillNames.flatMap((skillName) => {
    const url = resolveSkillRef(skillName);
    const parsed = parseGitHubTreeUrl(url);
    if (!parsed) {
      return [];
    }
    return [
      {
        name: getSkillStorageName(parsed.fullPath),
        mountPath: skillMountPath(framework, parsed.skillName),
        system: true,
      },
    ];
  });
}

function buildCustomSkillVolumes(
  customSkills: readonly string[],
  framework: SupportedFramework,
): readonly AdditionalVolume[] {
  return customSkills.map((name) => {
    return {
      name: getCustomSkillStorageName(name),
      mountPath: skillMountPath(framework, name),
    };
  });
}

function buildInjectedSkillVolumes(
  args: CreateAgentRunArgs,
  framework: SupportedFramework,
): readonly AdditionalVolume[] | undefined {
  if (!args.injectSkillVolumes) {
    return undefined;
  }
  return [
    ...buildSystemSkillVolumes(args.allowedConnectorTypes ?? [], framework),
    ...buildCustomSkillVolumes(args.injectSkillVolumes.customSkills, framework),
  ];
}

function isRouteError(value: unknown): value is CreateRunErrorResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof (value as { readonly status: unknown }).status === "number" &&
    (value as { readonly status: number }).status !== 201
  );
}

function firstAgent(content: AgentComposeContent): AgentConfig | undefined {
  if (content.agent) {
    return content.agent;
  }
  if (!content.agents) {
    return undefined;
  }
  const firstKey = Object.keys(content.agents)[0];
  return firstKey ? content.agents[firstKey] : undefined;
}

function resolveFramework(
  content: AgentComposeContent,
): SupportedFramework | null {
  const framework = firstAgent(content)?.framework;
  if (!isSupportedFramework(framework)) {
    return null;
  }
  return framework;
}

function modelProviderFramework(
  modelProvider: ResolvedModelProviderEnvironment,
): SupportedFramework {
  return getFrameworkForType(modelProvider.concreteType ?? modelProvider.type);
}

function frameworkForProviderSelection(
  providerType: ModelProviderType,
  selectedModel: string | null | undefined,
): SupportedFramework | null {
  if (providerType !== "vm0") {
    return getFrameworkForType(providerType);
  }
  if (!selectedModel) {
    return null;
  }
  return getFrameworkForType(getVm0ConcreteProviderType(selectedModel));
}

async function resolveRequestedRunFramework(
  db: Db,
  args: CreateAgentRunArgs,
  composeFramework: SupportedFramework,
): Promise<SupportedFramework> {
  if (args.modelProviderType && isModelProviderType(args.modelProviderType)) {
    return (
      frameworkForProviderSelection(
        args.modelProviderType,
        args.selectedModelOverride,
      ) ?? composeFramework
    );
  }

  if (!args.modelProviderId) {
    return composeFramework;
  }

  const [provider] = await db
    .select({
      type: modelProviders.type,
      selectedModel: modelProviders.selectedModel,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.id, args.modelProviderId),
        eq(modelProviders.orgId, args.orgId),
        or(
          eq(modelProviders.userId, args.userId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      ),
    )
    .limit(1);

  if (!provider || !isModelProviderType(provider.type)) {
    return composeFramework;
  }

  return (
    frameworkForProviderSelection(
      provider.type,
      args.selectedModelOverride ?? provider.selectedModel,
    ) ?? composeFramework
  );
}

function frameworkWorkingDir(_framework: SupportedFramework): string {
  return "/home/user/workspace";
}

function frameworkApiKeyEnv(framework: SupportedFramework): string {
  return framework === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

function autoMemoryArtifact(framework: SupportedFramework): ContextArtifact {
  return {
    name: AUTO_MEMORY_ARTIFACT_NAME,
    mountPath:
      framework === "codex"
        ? CODEX_AUTO_MEMORY_MOUNT_PATH
        : AUTO_MEMORY_MOUNT_PATH,
  };
}

function withAutoMemoryArtifact(
  artifacts: readonly ContextArtifact[],
  framework: SupportedFramework,
): readonly ContextArtifact[] {
  if (
    artifacts.some((artifact) => {
      return artifact.name === AUTO_MEMORY_ARTIFACT_NAME;
    })
  ) {
    return artifacts;
  }
  return [...artifacts, autoMemoryArtifact(framework)];
}

function resolveComposeArtifactMountPath(
  artifact: ComposeArtifact,
  framework: SupportedFramework,
): string {
  if (!artifact.mount_path || artifact.mount_path === MOUNT_PATH_TEMPLATE) {
    return frameworkWorkingDir(framework);
  }
  return artifact.mount_path;
}

function composeArtifacts(
  content: AgentComposeContent,
  framework: SupportedFramework,
): readonly ContextArtifact[] {
  return (content.artifacts ?? []).map((artifact) => {
    return {
      name: artifact.name,
      version: artifact.version,
      mountPath: resolveComposeArtifactMountPath(artifact, framework),
    };
  });
}

function artifactsForRun(args: {
  readonly resolved: ResolvedCompose;
  readonly framework: SupportedFramework;
  readonly bodyArtifacts: readonly ContextArtifact[] | undefined;
}): readonly ContextArtifact[] {
  const baseArtifacts =
    args.resolved.sessionId || args.resolved.resumedFromCheckpointId
      ? args.resolved.artifacts
      : [
          ...composeArtifacts(args.resolved.content, args.framework),
          ...args.resolved.artifacts,
        ];
  return withAutoMemoryArtifact(
    [...baseArtifacts, ...(args.bodyArtifacts ?? [])],
    args.framework,
  );
}

function runnerGroup(content: AgentComposeContent): string | null {
  return firstAgent(content)?.experimental_runner?.group ?? null;
}

function runnerProfile(content: AgentComposeContent): string {
  return firstAgent(content)?.experimental_profile ?? DEFAULT_PROFILE;
}

function isOfficialRunnerGroup(group: string): boolean {
  return group.split("/")[0] === "vm0";
}

function expandEnvironment(
  content: AgentComposeContent,
  vars: Record<string, string> | undefined,
  secrets: Record<string, string> | undefined,
  additionalEnvironment: Record<string, string> | undefined,
): Record<string, string> | null {
  const environment = firstAgent(content)?.environment;
  const mergedEnvironment = {
    ...additionalEnvironment,
    ...environment,
  };
  if (Object.keys(mergedEnvironment).length === 0) {
    return null;
  }

  const { result } = expandVariables(mergedEnvironment, { vars, secrets });
  return result;
}

function missingEnvironmentReferences(
  content: AgentComposeContent,
  vars: Record<string, string> | undefined,
  secrets: Record<string, string> | undefined,
): string[] {
  const environment = firstAgent(content)?.environment;
  if (!environment) {
    return [];
  }
  const grouped = extractAndGroupVariables(environment);
  const missingVars = grouped.vars
    .filter((ref) => {
      return vars?.[ref.name] === undefined;
    })
    .map((ref) => {
      return `vars.${ref.name}`;
    });
  const missingSecrets = grouped.secrets
    .filter((ref) => {
      return secrets?.[ref.name] === undefined;
    })
    .map((ref) => {
      return `secrets.${ref.name}`;
    });
  return [...missingVars, ...missingSecrets];
}

function hasExplicitFrameworkApiKey(
  content: AgentComposeContent,
  framework: SupportedFramework,
): boolean {
  return (
    firstAgent(content)?.environment?.[frameworkApiKeyEnv(framework)] !==
    undefined
  );
}

function isModelProviderType(type: string): type is ModelProviderType {
  return Object.hasOwn(MODEL_PROVIDER_TYPES, type);
}

interface SingleSecretModelProviderConfig {
  readonly framework: SupportedFramework;
  readonly secretName: string;
  readonly environmentMapping: Record<string, string>;
  readonly defaultModel?: string;
}

function isSingleSecretModelProviderConfig(
  value: unknown,
): value is SingleSecretModelProviderConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "framework" in value &&
    "secretName" in value &&
    "environmentMapping" in value &&
    typeof (value as { readonly secretName: unknown }).secretName === "string"
  );
}

function modelProviderEnvironment(
  id: string | null,
  type: ModelProviderType,
  config: SingleSecretModelProviderConfig,
  secretValue: string,
  selectedModel: string | null,
): ResolvedModelProviderEnvironment {
  const model = selectedModel ?? config.defaultModel ?? "";
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.environmentMapping)) {
    environment[key] = value
      .replaceAll("$secret", secretValue)
      .replaceAll("$model", model);
  }

  return {
    id,
    type,
    environment,
    secrets: { [config.secretName]: secretValue },
    selectedModel: model || null,
  };
}

function providerEnvironmentFromSecretRefs(
  type: ModelProviderType,
  secretName: string | undefined,
  secretValue: string | undefined,
  selectedModel: string | null,
): Record<string, string> {
  const mapping = getEnvironmentMapping(type);
  if (!mapping) {
    return secretName && secretValue ? { [secretName]: secretValue } : {};
  }

  const model = selectedModel ?? MODEL_PROVIDER_TYPES[type].defaultModel ?? "";
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (value === "$secret") {
      if (secretValue) {
        environment[key] = secretValue;
      }
    } else if (value === "$model") {
      if (model) {
        environment[key] = model;
      }
    } else if (value.startsWith("$secrets.")) {
      const referencedSecret = value.slice("$secrets.".length);
      if (referencedSecret === secretName && secretValue) {
        environment[key] = secretValue;
      }
    } else {
      environment[key] = value;
    }
  }
  return environment;
}

function providerEnvironmentFromSecretMap(
  type: ModelProviderType,
  providerSecrets: Record<string, string>,
  selectedModel: string | null,
): Record<string, string> {
  const mapping = getEnvironmentMapping(type);
  if (!mapping) {
    return providerSecrets;
  }

  const fallbackSecret = Object.values(providerSecrets)[0];
  const model = selectedModel ?? getDefaultModel(type) ?? "";
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (value === "$secret") {
      if (fallbackSecret) {
        environment[key] = fallbackSecret;
      }
    } else if (value === "$model") {
      if (model) {
        environment[key] = model;
      }
    } else if (value.startsWith("$secrets.")) {
      const secretName = value.slice("$secrets.".length);
      const secretValue = providerSecrets[secretName];
      if (secretValue) {
        environment[key] = secretValue;
      }
    } else {
      environment[key] = value;
    }
  }
  return environment;
}

function modelProviderHandlerKey(
  providerType: ModelProviderType,
): keyof typeof PROVIDER_HANDLERS | undefined {
  switch (providerType) {
    case "codex-oauth-token": {
      return "codex-oauth";
    }
    default: {
      return undefined;
    }
  }
}

function modelProviderRefreshMaps(
  providerType: ModelProviderType,
  sourceUserId: string,
):
  | {
      readonly secretConnectorMap: Record<string, string>;
      readonly secretConnectorMetadataMap: Record<
        string,
        SecretConnectorMetadata
      >;
    }
  | undefined {
  const handlerKey = modelProviderHandlerKey(providerType);
  if (!handlerKey) {
    return undefined;
  }

  const handler = PROVIDER_HANDLERS[handlerKey];
  if (!handler.refreshToken) {
    return undefined;
  }

  const accessSecretName = handler.getSecretName();
  const secretConnectorMap: Record<string, string> = {
    [accessSecretName]: handlerKey,
  };
  const mapping = getEnvironmentMapping(providerType);
  for (const [envName, valueRef] of Object.entries(mapping ?? {})) {
    if (valueRef === `$secrets.${accessSecretName}`) {
      secretConnectorMap[envName] = handlerKey;
    }
  }

  const secretConnectorMetadataMap = Object.fromEntries(
    Object.keys(secretConnectorMap).map((key) => {
      return [
        key,
        {
          sourceType: "model-provider" as const,
          sourceUserId,
          metadataKey: providerType,
        },
      ];
    }),
  );

  return { secretConnectorMap, secretConnectorMetadataMap };
}

async function multiAuthModelProviderEnvironment(
  db: Db,
  args: {
    readonly id: string | null;
    readonly orgId: string;
    readonly userId: string;
    readonly type: ModelProviderType;
    readonly authMethod: string | null;
    readonly selectedModel: string | null;
  },
): Promise<ResolvedModelProviderEnvironment | null> {
  if (!args.authMethod) {
    return null;
  }
  const secretConfig = getSecretsForAuthMethod(args.type, args.authMethod);
  if (!secretConfig) {
    return null;
  }

  const secretRows = await db
    .select({
      name: secretsTable.name,
      encryptedValue: secretsTable.encryptedValue,
    })
    .from(secretsTable)
    .where(
      and(
        eq(secretsTable.orgId, args.orgId),
        eq(secretsTable.userId, args.userId),
        eq(secretsTable.type, "model-provider"),
      ),
    );
  const storedSecrets: Record<string, string> = {};
  for (const row of secretRows) {
    storedSecrets[row.name] = decryptSecretValue(row.encryptedValue);
  }

  const forwardableSecrets: Record<string, string> = {};
  for (const [secretName, config] of Object.entries(secretConfig)) {
    const value = storedSecrets[secretName];
    if (!value) {
      if (config.required) {
        return null;
      }
      continue;
    }
    if (!config.serverOnly) {
      forwardableSecrets[secretName] = value;
    }
  }

  const selectedModel =
    args.selectedModel ?? getDefaultModel(args.type) ?? null;
  const runtimeModel = selectedModel
    ? getProviderRuntimeModel(args.type, selectedModel)
    : null;
  const refreshMaps = modelProviderRefreshMaps(args.type, args.userId);
  return {
    id: args.id,
    type: args.type,
    environment: providerEnvironmentFromSecretMap(
      args.type,
      forwardableSecrets,
      runtimeModel,
    ),
    secrets: forwardableSecrets,
    selectedModel,
    secretConnectorMap: refreshMaps?.secretConnectorMap,
    secretConnectorMetadataMap: refreshMaps?.secretConnectorMetadataMap,
  };
}

async function vm0ModelProviderEnvironment(
  db: Db,
  selectedModel: string,
): Promise<ResolvedModelProviderEnvironment | null> {
  const concreteType = getVm0ConcreteProviderType(selectedModel);
  const vendor = getVm0Vendor(selectedModel);
  const apiModel = getProviderRuntimeModel("vm0", selectedModel);
  const exactRows = await db
    .select({ apiKey: vm0ApiKeys.apiKey })
    .from(vm0ApiKeys)
    .where(and(eq(vm0ApiKeys.vendor, vendor), eq(vm0ApiKeys.model, apiModel)))
    .orderBy(sql`random()`)
    .limit(1);
  const fallbackRows =
    exactRows.length > 0
      ? exactRows
      : await db
          .select({ apiKey: vm0ApiKeys.apiKey })
          .from(vm0ApiKeys)
          .where(eq(vm0ApiKeys.vendor, vendor))
          .orderBy(sql`random()`)
          .limit(1);
  const apiKey = fallbackRows[0]?.apiKey;
  const secretName = getSecretNameForType(concreteType);
  if (!apiKey || !secretName) {
    return null;
  }

  return {
    id: null,
    type: "vm0",
    concreteType,
    environment: providerEnvironmentFromSecretRefs(
      concreteType,
      secretName,
      apiKey,
      apiModel,
    ),
    secrets: { [secretName]: apiKey },
    selectedModel,
  };
}

interface ResolveModelProviderEnvironmentArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly framework: SupportedFramework;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly modelProviderType?: string;
  readonly selectedModelOverride?: string;
}

interface ModelProviderEnvironmentRow {
  readonly id: string;
  readonly type: string;
  readonly userId: string;
  readonly isDefault: boolean;
  readonly selectedModel: string | null;
  readonly authMethod: string | null;
  readonly encryptedValue: string | null;
}

interface ResolvableModelProviderEnvironmentRow extends ModelProviderEnvironmentRow {
  readonly type: ModelProviderType;
}

function isCandidateModelProviderRow(
  row: ModelProviderEnvironmentRow,
  args: ResolveModelProviderEnvironmentArgs,
): row is ResolvableModelProviderEnvironmentRow {
  if (args.modelProviderId && row.id !== args.modelProviderId) {
    return false;
  }
  if (
    args.modelProviderCredentialScope === "org" &&
    row.userId !== ORG_SENTINEL_USER_ID
  ) {
    return false;
  }
  if (
    args.modelProviderCredentialScope === "member" &&
    row.userId !== args.userId
  ) {
    return false;
  }
  if (args.modelProviderType && row.type !== args.modelProviderType) {
    return false;
  }
  return isModelProviderType(row.type);
}

async function resolveCandidateModelProviderEnvironment(
  db: Db,
  args: ResolveModelProviderEnvironmentArgs,
  row: ResolvableModelProviderEnvironmentRow,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (row.type === "vm0") {
    const selectedModel =
      args.selectedModelOverride ??
      row.selectedModel ??
      MODEL_PROVIDER_TYPES.vm0.defaultModel;
    const provider = await vm0ModelProviderEnvironment(db, selectedModel);
    return provider?.concreteType &&
      getFrameworkForType(provider.concreteType) === args.framework
      ? provider
      : null;
  }

  if (getFrameworkForType(row.type) !== args.framework) {
    return null;
  }

  if (hasAuthMethods(row.type)) {
    return await multiAuthModelProviderEnvironment(db, {
      id: row.id,
      orgId: args.orgId,
      userId: row.userId,
      type: row.type,
      authMethod: row.authMethod,
      selectedModel: args.selectedModelOverride ?? row.selectedModel,
    });
  }

  const config = MODEL_PROVIDER_TYPES[row.type];
  if (!isSingleSecretModelProviderConfig(config) || !row.encryptedValue) {
    return null;
  }
  return modelProviderEnvironment(
    row.id,
    row.type,
    config,
    decryptSecretValue(row.encryptedValue),
    args.selectedModelOverride ?? row.selectedModel,
  );
}

async function resolveModelProviderEnvironment(
  db: Db,
  args: ResolveModelProviderEnvironmentArgs,
): Promise<ResolvedModelProviderEnvironment | null> {
  const rows = await db
    .select({
      id: modelProviders.id,
      type: modelProviders.type,
      userId: modelProviders.userId,
      isDefault: modelProviders.isDefault,
      selectedModel: modelProviders.selectedModel,
      authMethod: modelProviders.authMethod,
      encryptedValue: secretsTable.encryptedValue,
    })
    .from(modelProviders)
    .leftJoin(secretsTable, eq(modelProviders.secretId, secretsTable.id))
    .where(
      and(
        eq(modelProviders.orgId, args.orgId),
        or(
          eq(modelProviders.userId, args.userId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      ),
    );

  const sortedRows = rows.sort((left, right) => {
    const leftUser = left.userId === args.userId ? 1 : 0;
    const rightUser = right.userId === args.userId ? 1 : 0;
    if (leftUser !== rightUser) {
      return rightUser - leftUser;
    }
    const leftDefault = left.isDefault ? 1 : 0;
    const rightDefault = right.isDefault ? 1 : 0;
    return rightDefault - leftDefault;
  });

  for (const row of sortedRows) {
    if (!isCandidateModelProviderRow(row, args)) {
      continue;
    }
    const provider = await resolveCandidateModelProviderEnvironment(
      db,
      args,
      row,
    );
    if (provider) {
      return provider;
    }
  }

  return null;
}

async function loadMergedVariables(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly runVars: Record<string, string> | undefined;
  },
): Promise<Record<string, string> | undefined> {
  const rows = await db
    .select({
      name: variables.name,
      value: variables.value,
      userId: variables.userId,
    })
    .from(variables)
    .where(
      and(
        eq(variables.orgId, args.orgId),
        or(
          eq(variables.userId, ORG_SENTINEL_USER_ID),
          eq(variables.userId, args.userId),
        ),
      ),
    );

  const orgVars: Record<string, string> = {};
  const userVars: Record<string, string> = {};
  for (const row of rows) {
    if (row.userId === ORG_SENTINEL_USER_ID) {
      orgVars[row.name] = row.value;
    } else {
      userVars[row.name] = row.value;
    }
  }

  const merged = { ...orgVars, ...userVars, ...args.runVars };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function loadReferencedSecrets(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly content: AgentComposeContent;
    readonly runSecrets: Record<string, string> | undefined;
    readonly allowedConnectorTypes: readonly ConnectorType[] | undefined;
  },
): Promise<Record<string, string> | undefined> {
  const environment = firstAgent(args.content)?.environment;
  if (!environment) {
    return args.runSecrets;
  }

  const referencedNames = extractAndGroupVariables(environment).secrets.map(
    (ref) => {
      return ref.name;
    },
  );
  if (referencedNames.length === 0) {
    return args.runSecrets;
  }

  const [rows, apiTokenTypes] = await Promise.all([
    db
      .select({
        name: secretsTable.name,
        encryptedValue: secretsTable.encryptedValue,
        userId: secretsTable.userId,
      })
      .from(secretsTable)
      .where(
        and(
          eq(secretsTable.orgId, args.orgId),
          eq(secretsTable.type, "user"),
          inArray(secretsTable.name, referencedNames),
          or(
            eq(secretsTable.userId, ORG_SENTINEL_USER_ID),
            eq(secretsTable.userId, args.userId),
          ),
        ),
      ),
    loadApiTokenConnectorTypes(db, {
      orgId: args.orgId,
      userId: args.userId,
    }),
  ]);

  const orgSecrets: Record<string, string> = {};
  const userSecrets: Record<string, string> = {};
  for (const row of rows) {
    const target =
      row.userId === ORG_SENTINEL_USER_ID ? orgSecrets : userSecrets;
    target[row.name] = decryptSecretValue(row.encryptedValue);
  }

  const filteredSecrets = filterDbSecretsByConnectorPermissions({
    dbSecrets: { ...orgSecrets, ...userSecrets },
    allApiTokenTypes: apiTokenTypes,
    allowedConnectorTypes: args.allowedConnectorTypes,
  });
  const merged = { ...filteredSecrets, ...args.runSecrets };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function loadApiTokenConnectorTypes(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<readonly ConnectorType[]> {
  const [secretRows, variableRows] = await Promise.all([
    db
      .select({ name: secretsTable.name })
      .from(secretsTable)
      .where(
        and(
          eq(secretsTable.orgId, args.orgId),
          eq(secretsTable.userId, args.userId),
          eq(secretsTable.type, "user"),
        ),
      ),
    db
      .select({ name: variables.name })
      .from(variables)
      .where(
        and(eq(variables.orgId, args.orgId), eq(variables.userId, args.userId)),
      ),
  ]);

  return deriveApiTokenConnectedTypes(
    new Set(
      secretRows.map((row) => {
        return row.name;
      }),
    ),
    new Set(
      variableRows.map((row) => {
        return row.name;
      }),
    ),
  );
}

function filterDbSecretsByConnectorPermissions(args: {
  readonly dbSecrets: Record<string, string>;
  readonly allApiTokenTypes: readonly ConnectorType[];
  readonly allowedConnectorTypes: readonly ConnectorType[] | undefined;
}): Record<string, string> | undefined {
  if (Object.keys(args.dbSecrets).length === 0) {
    return undefined;
  }
  if (!args.allowedConnectorTypes) {
    return args.dbSecrets;
  }

  const allConnectorSecretNames = getConnectorProvidedSecretNames([
    ...args.allApiTokenTypes,
  ]);
  const allowedApiTokenTypes = args.allApiTokenTypes.filter((type) => {
    return args.allowedConnectorTypes?.includes(type);
  });
  const allowedConnectorSecretNames =
    getConnectorProvidedSecretNames(allowedApiTokenTypes);
  const filtered: Record<string, string> = {};

  for (const [name, value] of Object.entries(args.dbSecrets)) {
    if (
      allConnectorSecretNames.has(name) &&
      !allowedConnectorSecretNames.has(name)
    ) {
      continue;
    }
    filtered[name] = value;
  }

  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function compactRecord(
  values: Record<string, string>,
): Record<string, string> | undefined {
  return Object.keys(values).length > 0 ? values : undefined;
}

function mergeRecords(
  ...records: readonly (Record<string, string> | undefined)[]
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  for (const record of records) {
    if (record) {
      Object.assign(merged, record);
    }
  }
  return compactRecord(merged);
}

function filterSecretConnectorMap(args: {
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly overriddenSecrets: readonly (Record<string, string> | undefined)[];
}): Record<string, string> | undefined {
  if (!args.secretConnectorMap) {
    return undefined;
  }

  const overridden = new Set<string>();
  for (const secrets of args.overriddenSecrets) {
    for (const key of Object.keys(secrets ?? {})) {
      overridden.add(key);
    }
  }
  const filtered = Object.fromEntries(
    Object.entries(args.secretConnectorMap).filter(([key]) => {
      return !overridden.has(key);
    }),
  );
  return compactRecord(filtered);
}

async function loadOauthConnectorContext(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedConnectorTypes: readonly ConnectorType[] | undefined;
  },
): Promise<ConnectorRuntimeContext> {
  const connectorRows = await db
    .select({ type: connectors.type })
    .from(connectors)
    .where(
      and(eq(connectors.orgId, args.orgId), eq(connectors.userId, args.userId)),
    );
  if (connectorRows.length === 0) {
    return {
      secrets: undefined,
      secretConnectorMap: undefined,
      connectorTypes: [],
    };
  }

  const validConnectorTypes = connectorRows.flatMap((row) => {
    const parsed = connectorTypeSchema.safeParse(row.type);
    return parsed.success ? [parsed.data] : [];
  });
  const allowedConnectorTypes = args.allowedConnectorTypes
    ? validConnectorTypes.filter((type) => {
        return args.allowedConnectorTypes?.includes(type);
      })
    : validConnectorTypes;
  if (allowedConnectorTypes.length === 0) {
    return {
      secrets: undefined,
      secretConnectorMap: undefined,
      connectorTypes: [],
    };
  }

  const secretRows = await db
    .select({
      name: secretsTable.name,
      encryptedValue: secretsTable.encryptedValue,
    })
    .from(secretsTable)
    .where(
      and(
        eq(secretsTable.orgId, args.orgId),
        eq(secretsTable.userId, args.userId),
        eq(secretsTable.type, "connector"),
      ),
    );
  const connectorSecrets: Record<string, string> = {};
  for (const row of secretRows) {
    connectorSecrets[row.name] = decryptSecretValue(row.encryptedValue);
  }

  const resolvedSecrets: Record<string, string> = {};
  const secretConnectorMap: Record<string, string> = {};
  for (const connectorType of allowedConnectorTypes) {
    const mapping = getConnectorEnvironmentMapping(connectorType);
    for (const [envName, valueRef] of Object.entries(mapping)) {
      if (valueRef.startsWith("$secrets.")) {
        const secretName = valueRef.slice("$secrets.".length);
        const secretValue = connectorSecrets[secretName];
        if (secretValue) {
          resolvedSecrets[envName] = secretValue;
        }
      } else {
        resolvedSecrets[envName] = valueRef;
      }
    }

    if (connectorType === "computer") {
      continue;
    }
    const handler = PROVIDER_HANDLERS[connectorType];
    if (!handler.refreshToken) {
      continue;
    }
    const secretName = handler.getSecretName();
    secretConnectorMap[secretName] = connectorType;
    for (const [envName, valueRef] of Object.entries(mapping)) {
      if (valueRef === `$secrets.${secretName}`) {
        secretConnectorMap[envName] = connectorType;
      }
    }
  }

  return {
    secrets: compactRecord(resolvedSecrets),
    secretConnectorMap: compactRecord(secretConnectorMap),
    connectorTypes: allowedConnectorTypes,
  };
}

function injectPlatformEnvSecrets(
  connectorTypes: readonly ConnectorType[],
): Record<string, string> | undefined {
  if (!connectorTypes.includes("google-ads")) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const name of PLATFORM_ENV_SECRET_NAMES) {
    const value = optionalEnv(name);
    if (value) {
      result[name] = value;
    }
  }
  return compactRecord(result);
}

function customConnectorSecretKey(connectorId: string): string {
  return `CUSTOM_${connectorId.replaceAll("-", "").toUpperCase()}`;
}

async function loadCustomConnectorContext(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedCustomConnectorIds: readonly string[] | undefined;
  },
): Promise<CustomConnectorRuntimeContext> {
  if (args.allowedCustomConnectorIds?.length === 0) {
    return { firewalls: [], secrets: undefined };
  }

  const rows = await db
    .select({
      id: orgCustomConnectors.id,
      slug: orgCustomConnectors.slug,
      displayName: orgCustomConnectors.displayName,
      prefixes: orgCustomConnectors.prefixes,
      headerName: orgCustomConnectors.headerName,
      headerTemplate: orgCustomConnectors.headerTemplate,
      encryptedValue: orgCustomConnectorSecrets.encryptedValue,
    })
    .from(orgCustomConnectors)
    .innerJoin(
      orgCustomConnectorSecrets,
      and(
        eq(orgCustomConnectorSecrets.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorSecrets.userId, args.userId),
      ),
    )
    .where(
      args.allowedCustomConnectorIds
        ? and(
            eq(orgCustomConnectors.orgId, args.orgId),
            inArray(orgCustomConnectors.id, [
              ...args.allowedCustomConnectorIds,
            ]),
          )
        : eq(orgCustomConnectors.orgId, args.orgId),
    );

  const firewalls: ExpandedFirewallConfig[] = [];
  const secrets: Record<string, string> = {};
  for (const row of rows) {
    const secretKey = customConnectorSecretKey(row.id);
    firewalls.push({
      name: row.slug,
      description: row.displayName,
      apis: row.prefixes.map((prefix) => {
        return {
          base: expandHostWildcardsInBaseUrl(prefix),
          auth: {
            headers: {
              [row.headerName]: row.headerTemplate.replaceAll(
                CUSTOM_CONNECTOR_SECRET_PLACEHOLDER,
                `\${{ secrets.${secretKey} }}`,
              ),
            },
          },
        };
      }),
    });
    secrets[secretKey] = decryptSecretValue(row.encryptedValue);
  }

  return { firewalls, secrets: compactRecord(secrets) };
}

function collectPermissionNames(
  apis: ExpandedFirewallConfig["apis"],
): readonly string[] {
  const names = new Set<string>();
  for (const api of apis) {
    for (const permission of api.permissions ?? []) {
      names.add(permission.name);
    }
  }
  return [...names];
}

function applyConnectorPolicies(
  connectorFirewalls: readonly ExpandedFirewallConfig[],
  policies: FirewallPolicies | undefined,
): PermissionManifest {
  const firewalls: Firewalls = [];
  const networkPolicies: NetworkPolicies = {};

  for (const firewall of connectorFirewalls) {
    const policy = policies?.[firewall.name];
    const permissionNames = collectPermissionNames(firewall.apis);
    firewalls.push({
      name: firewall.name,
      apis: firewall.apis.map((api) => {
        return {
          base: api.base,
          auth: api.auth,
          permissions: api.permissions ?? [],
        };
      }),
    });

    if (!policy) {
      networkPolicies[firewall.name] = {
        allow: [...permissionNames],
        deny: [],
        ask: [],
        unknownPolicy: "allow",
      };
      continue;
    }

    const allow: string[] = [];
    const deny: string[] = [];
    const ask: string[] = [];
    for (const name of permissionNames) {
      const value = policy.policies[name];
      if (value === "allow") {
        allow.push(name);
      } else if (value === "deny") {
        deny.push(name);
      } else if (value === "ask") {
        ask.push(name);
      }
    }
    networkPolicies[firewall.name] = {
      allow,
      deny,
      ask,
      unknownPolicy: policy.unknownPolicy ?? "allow",
    };
  }

  return { firewalls, networkPolicies };
}

function modelProviderPermissionManifest(
  modelProvider: ResolvedModelProviderEnvironment | null,
): PermissionManifest | undefined {
  if (!modelProvider) {
    return undefined;
  }

  const firewall = getModelProviderFirewall(
    modelProvider.concreteType ?? modelProvider.type,
  );
  if (!firewall) {
    return undefined;
  }

  const permissionNames = collectPermissionNames(firewall.apis);
  const denySet = new Set(firewall.defaultPolicies?.deny ?? []);
  const askSet = new Set(firewall.defaultPolicies?.ask ?? []);
  return {
    firewalls: [firewall],
    networkPolicies: {
      [firewall.name]: {
        allow: permissionNames.filter((name) => {
          return !denySet.has(name) && !askSet.has(name);
        }),
        deny: [...denySet],
        ask: [...askSet],
        unknownPolicy: firewall.defaultPolicies?.unknownPolicy ?? "allow",
      },
    },
  };
}

function buildPermissionManifest(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly permissionPolicies: FirewallPolicies | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly connectorTypes?: readonly ConnectorType[];
  readonly customConnectorFirewalls?: readonly ExpandedFirewallConfig[];
}): PermissionManifest | undefined {
  const connectorTypes =
    args.connectorTypes ??
    Object.keys(args.permissionPolicies ?? {}).filter(isFirewallConnectorType);
  const connectorFirewalls = connectorTypes
    .filter(isFirewallConnectorType)
    .map((type) => {
      return getConnectorFirewall(type);
    });
  const connectorManifest = applyConnectorPolicies(
    [...connectorFirewalls, ...(args.customConnectorFirewalls ?? [])],
    args.permissionPolicies,
  );
  const providerManifest = modelProviderPermissionManifest(args.modelProvider);
  const firewalls = [
    ...(providerManifest?.firewalls ?? []),
    ...connectorManifest.firewalls,
  ];

  if (firewalls.length === 0) {
    return undefined;
  }

  return {
    firewalls: resolveFirewallBaseUrlVars(firewalls, args.vars),
    networkPolicies: {
      ...providerManifest?.networkPolicies,
      ...connectorManifest.networkPolicies,
    },
  };
}

function parseVolumeVersionsSnapshot(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (
    "versions" in value &&
    typeof value.versions === "object" &&
    value.versions !== null
  ) {
    return value.versions as Record<string, string>;
  }
  return value as Record<string, string>;
}

function parseAdditionalVolumeSnapshot(
  value: unknown,
): AdditionalVolume | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as {
    readonly name?: unknown;
    readonly versionId?: unknown;
    readonly mountPath?: unknown;
  };
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.versionId !== "string" ||
    typeof candidate.mountPath !== "string"
  ) {
    return null;
  }
  return {
    name: candidate.name,
    version: candidate.versionId,
    mountPath: candidate.mountPath,
  };
}

function parseAdditionalVolumesSnapshot(
  value: unknown,
): readonly AdditionalVolume[] | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("additionalVolumes" in value)
  ) {
    return undefined;
  }
  const additionalVolumes = (value as { readonly additionalVolumes?: unknown })
    .additionalVolumes;
  if (!Array.isArray(additionalVolumes)) {
    return undefined;
  }
  const parsed = additionalVolumes.flatMap((item) => {
    const volume = parseAdditionalVolumeSnapshot(item);
    return volume ? [volume] : [];
  });
  return parsed.length > 0 ? parsed : undefined;
}

async function orgTier(
  db: Db,
  orgId: string,
): Promise<keyof typeof TIER_LIMITS> {
  const [row] = await db
    .select({ tier: orgMetadata.tier })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  return row?.tier === "pro" || row?.tier === "team" ? row.tier : "free";
}

async function checkRunConcurrencyLimit(
  tx: Db,
  orgId: string,
): Promise<CreateRunErrorResult | null> {
  const limit = TIER_LIMITS[await orgTier(tx, orgId)];

  const staleThreshold = new Date(now() - PENDING_RUN_TTL_MS);
  const [activeResult] = await tx
    .select({ count: count() })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        or(
          eq(agentRuns.status, "running"),
          and(
            eq(agentRuns.status, "pending"),
            gt(agentRuns.createdAt, staleThreshold),
          ),
        ),
      ),
    );
  const activeCount = Number(activeResult?.count ?? 0);
  return activeCount >= limit ? concurrentRunLimit() : null;
}

async function checkVm0Credits(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
): Promise<CreateRunErrorResult | null> {
  const { rows } = await db.execute<CreditCheckRow>(sql`
    WITH member AS (
      SELECT credit_enabled FROM org_members_metadata
      WHERE org_id = ${args.orgId} AND user_id = ${args.userId}
      LIMIT 1
    ),
    org AS (
      SELECT credits FROM org_metadata
      WHERE org_id = ${args.orgId}
      LIMIT 1
    ),
    expired AS (
      SELECT COALESCE(SUM(remaining), 0)::bigint AS total
      FROM credit_expires_record
      WHERE org_id = ${args.orgId}
        AND expires_at <= now()
        AND remaining > 0
    )
    SELECT
      (SELECT credit_enabled FROM member) AS credit_enabled,
      (SELECT credits FROM org) AS credits,
      (SELECT total FROM expired) AS unsettled_expired
  `);

  const row = rows[0];
  if (!row || row.credits === null) {
    return notFound("Org metadata not found");
  }
  if (row.credit_enabled === false) {
    return insufficientCredits();
  }

  const credits = Number(row.credits);
  const unsettledExpired = Number(row.unsettled_expired ?? 0);
  return credits - unsettledExpired > 0 ? null : insufficientCredits();
}

async function lookupComposeByVersion(
  db: Db,
  versionId: string,
): Promise<ResolvedCompose | CreateRunErrorResult> {
  const [row] = await db
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

  if (!row?.composeId || !row.composeOrgId || !row.composeUserId) {
    return notFound("Agent compose version not found");
  }

  return {
    agentComposeVersionId: versionId,
    composeId: row.composeId,
    composeUserId: row.composeUserId,
    agentName: row.composeName ?? undefined,
    orgId: row.composeOrgId,
    content: row.versionContent as AgentComposeContent,
    artifacts: [],
  };
}

async function resolveByComposeId(
  db: Db,
  composeId: string,
): Promise<ResolvedCompose | CreateRunErrorResult> {
  const [row] = await db
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
    return notFound("Agent compose not found");
  }
  if (!row.headVersionId || !row.versionId) {
    return badRequestMessage(
      "Agent compose has no versions. Run 'vm0 build' first.",
    );
  }

  return {
    agentComposeVersionId: row.versionId,
    composeId: row.composeId,
    composeUserId: row.composeUserId,
    agentName: row.composeName || undefined,
    orgId: row.composeOrgId,
    content: row.versionContent as AgentComposeContent,
    artifacts: [],
  };
}

async function resolveBySessionId(
  get: ComputedGetter,
  db: Db,
  sessionId: string,
  userId: string,
  orgId: string,
): Promise<ResolvedCompose | CreateRunErrorResult> {
  const [session] = await db
    .select({
      id: agentSessions.id,
      agentComposeId: agentSessions.agentComposeId,
      conversationId: agentSessions.conversationId,
      artifacts: agentSessions.artifacts,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.userId, userId),
        eq(agentSessions.orgId, orgId),
      ),
    )
    .limit(1);

  if (!session) {
    return notFound("Agent session not found");
  }

  const resolved = await resolveByComposeId(db, session.agentComposeId);
  if (isRouteError(resolved)) {
    return resolved;
  }

  const resumeSession =
    session.conversationId === null
      ? undefined
      : await loadResumeSession(get, db, session.conversationId);

  return {
    ...resolved,
    artifacts: session.artifacts ?? [],
    sessionId: session.id,
    continuedFromSessionId: session.id,
    resumeSession,
  };
}

async function resolveByCheckpointId(
  get: ComputedGetter,
  db: Db,
  checkpointId: string,
  userId: string,
  orgId: string,
): Promise<ResolvedCompose | CreateRunErrorResult> {
  const [row] = await db
    .select({
      snapshot: checkpoints.agentComposeSnapshot,
      artifacts: checkpoints.artifactSnapshots,
      volumeVersionsSnapshot: checkpoints.volumeVersionsSnapshot,
      conversationId: checkpoints.conversationId,
      runUserId: agentRuns.userId,
      runOrgId: agentRuns.orgId,
    })
    .from(checkpoints)
    .leftJoin(agentRuns, eq(checkpoints.runId, agentRuns.id))
    .where(eq(checkpoints.id, checkpointId))
    .limit(1);

  if (!row || row.runUserId !== userId || row.runOrgId !== orgId) {
    return notFound("Checkpoint not found");
  }

  const snapshot = row.snapshot as { readonly agentComposeVersionId?: string };
  if (!snapshot.agentComposeVersionId) {
    return badRequestMessage(
      "Invalid checkpoint: missing agentComposeVersionId",
    );
  }

  const resolved = await lookupComposeByVersion(
    db,
    snapshot.agentComposeVersionId,
  );
  if (isRouteError(resolved)) {
    return resolved;
  }

  return {
    ...resolved,
    artifacts: row.artifacts ?? [],
    volumeVersions: parseVolumeVersionsSnapshot(row.volumeVersionsSnapshot),
    additionalVolumes: parseAdditionalVolumesSnapshot(
      row.volumeVersionsSnapshot,
    ),
    resumedFromCheckpointId: checkpointId,
    resumeSession: await loadResumeSession(get, db, row.conversationId),
  };
}

async function loadResumeSession(
  get: ComputedGetter,
  db: Db,
  conversationId: string,
): Promise<StoredExecutionContext["resumeSession"] | undefined> {
  const [conversation] = await db
    .select({
      cliAgentSessionId: conversations.cliAgentSessionId,
      cliAgentSessionHistory: conversations.cliAgentSessionHistory,
      cliAgentSessionHistoryHash: conversations.cliAgentSessionHistoryHash,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!conversation) {
    return undefined;
  }

  const sessionHistory = await resolveConversationSessionHistory(get, {
    hash: conversation.cliAgentSessionHistoryHash,
    legacyText: conversation.cliAgentSessionHistory,
  });

  if (sessionHistory === null) {
    return undefined;
  }

  return {
    sessionId: conversation.cliAgentSessionId,
    sessionHistory,
  };
}

async function resolveConversationSessionHistory(
  get: ComputedGetter,
  args: {
    readonly hash: string | null;
    readonly legacyText: string | null;
  },
): Promise<string | null> {
  const { hash, legacyText } = args;
  if (hash) {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const result = await safeAsync(() => {
      return get(downloadS3Buffer(bucket, `blobs/${hash}.blob`));
    });
    if ("ok" in result) {
      return result.ok.toString("utf8");
    }
    if (legacyText) {
      L.warn(
        "session history R2 retrieval failed; falling back to legacy TEXT",
        { hash, error: result.error },
      );
      return legacyText;
    }
    throw result.error;
  }
  if (legacyText) {
    return legacyText;
  }
  return null;
}

async function resolveCompose(
  get: ComputedGetter,
  db: Db,
  body: CreateRunBody,
  userId: string,
  orgId: string,
): Promise<ResolvedCompose | CreateRunErrorResult> {
  if (body.checkpointId && body.sessionId) {
    return badRequestMessage(
      "Cannot specify both checkpointId and sessionId. Use checkpointId to resume from a checkpoint, or sessionId to continue a session.",
    );
  }

  if (body.checkpointId) {
    return await resolveByCheckpointId(
      get,
      db,
      body.checkpointId,
      userId,
      orgId,
    );
  }
  if (body.sessionId) {
    return await resolveBySessionId(get, db, body.sessionId, userId, orgId);
  }
  if (body.agentComposeVersionId) {
    return await lookupComposeByVersion(db, body.agentComposeVersionId);
  }
  if (!body.agentComposeId) {
    return badRequestMessage(
      "Missing agentComposeId or agentComposeVersionId. Provide composeId, agentComposeVersionId, checkpointId, or sessionId.",
    );
  }
  return await resolveByComposeId(db, body.agentComposeId);
}

async function enforceCaptureNetworkBodiesGate(
  db: Db,
  userId: string,
  captureNetworkBodies: boolean | undefined,
): Promise<CreateRunErrorResult | null> {
  if (!captureNetworkBodies || env("ENV") !== "production") {
    return null;
  }

  const [cachedUser] = await db
    .select({ email: userCache.email })
    .from(userCache)
    .where(eq(userCache.userId, userId))
    .limit(1);

  if (!cachedUser?.email.endsWith("@vm0.ai")) {
    return forbidden("captureNetworkBodies is restricted to internal accounts");
  }
  return null;
}

function validateCompose(
  content: AgentComposeContent,
  vars: Record<string, string> | undefined,
  secrets: Record<string, string> | undefined,
  options?: { readonly validateEnvironmentReferences?: boolean },
): { readonly framework: SupportedFramework } | CreateRunErrorResult {
  const framework = resolveFramework(content);
  if (!framework) {
    return badRequestMessage(
      "Agent must have a supported framework configured",
    );
  }

  if (options?.validateEnvironmentReferences !== false) {
    const missing = missingEnvironmentReferences(content, vars, secrets);
    if (missing.length > 0) {
      return badRequestMessage(
        `Missing required values: ${missing.join(", ")}`,
      );
    }
  }

  return { framework };
}

async function insertZeroRunRecord(
  tx: Db,
  args: {
    readonly runId: string;
    readonly body: CreateRunBody;
    readonly modelProvider: ResolvedModelProviderEnvironment | null;
    readonly chatThreadId: string | undefined;
    readonly zeroRunMetadata: ZeroRunMetadata | undefined;
  },
): Promise<void> {
  await tx.insert(zeroRuns).values({
    id: args.runId,
    triggerSource: args.body.triggerSource ?? "cli",
    scheduleId: args.zeroRunMetadata?.scheduleId ?? null,
    triggerAgentId: args.zeroRunMetadata?.triggerAgentId ?? null,
    modelProvider: args.modelProvider?.type ?? null,
    modelProviderId: args.modelProvider?.id ?? null,
    selectedModel: args.modelProvider?.selectedModel ?? null,
    chatThreadId: args.chatThreadId ?? null,
  });
}

async function insertRunRecord(
  tx: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly resolved: ResolvedCompose;
    readonly body: CreateRunBody;
    readonly artifacts: readonly ContextArtifact[];
    readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
    readonly modelProvider: ResolvedModelProviderEnvironment | null;
    readonly callbacks: readonly RunCallback[] | undefined;
    readonly chatThreadId: string | undefined;
    readonly zeroRunMetadata: ZeroRunMetadata | undefined;
  },
): Promise<RunRecord> {
  const sessionId =
    args.resolved.sessionId ??
    (
      await tx
        .insert(agentSessions)
        .values({
          userId: args.userId,
          orgId: args.orgId,
          agentComposeId: args.resolved.composeId,
          artifacts: [...args.artifacts],
          conversationId: null,
        })
        .returning({ id: agentSessions.id })
    )[0]?.id;

  if (!sessionId) {
    throw new Error("Failed to create agent session");
  }

  const [run] = await tx
    .insert(agentRuns)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      agentComposeVersionId: args.resolved.agentComposeVersionId,
      status: "pending",
      prompt: args.body.prompt,
      appendSystemPrompt: args.body.appendSystemPrompt ?? null,
      vars: args.body.vars ?? null,
      secretNames: args.body.secrets ? Object.keys(args.body.secrets) : null,
      additionalVolumes: args.additionalVolumes
        ? [...args.additionalVolumes]
        : null,
      resumedFromCheckpointId: args.resolved.resumedFromCheckpointId ?? null,
      continuedFromSessionId: args.resolved.continuedFromSessionId ?? null,
      sessionId,
      lastHeartbeatAt: nowDate(),
    })
    .returning({
      id: agentRuns.id,
      createdAt: agentRuns.createdAt,
      sessionId: agentRuns.sessionId,
    });

  if (!run) {
    throw new Error("Failed to create run record");
  }

  await insertZeroRunRecord(tx, {
    runId: run.id,
    body: args.body,
    modelProvider: args.modelProvider,
    chatThreadId: args.chatThreadId,
    zeroRunMetadata: args.zeroRunMetadata,
  });

  if (args.callbacks && args.callbacks.length > 0) {
    await tx.insert(agentRunCallbacks).values(
      args.callbacks.map((callback) => {
        return {
          runId: run.id,
          url: callback.url,
          encryptedSecret: encryptSecretValue(callback.secret),
          payload: callback.payload,
        };
      }),
    );
  }

  return { ...run, status: "pending" };
}

async function insertQueuedRunRecord(
  tx: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly resolved: ResolvedCompose;
    readonly body: CreateRunBody;
    readonly artifacts: readonly ContextArtifact[];
    readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
    readonly modelProvider: ResolvedModelProviderEnvironment | null;
    readonly callbacks: readonly RunCallback[] | undefined;
    readonly chatThreadId: string | undefined;
    readonly zeroRunMetadata: ZeroRunMetadata | undefined;
  },
): Promise<RunRecord> {
  const sessionId =
    args.resolved.sessionId ??
    (
      await tx
        .insert(agentSessions)
        .values({
          userId: args.userId,
          orgId: args.orgId,
          agentComposeId: args.resolved.composeId,
          artifacts: [...args.artifacts],
          conversationId: null,
        })
        .returning({ id: agentSessions.id })
    )[0]?.id;

  if (!sessionId) {
    throw new Error("Failed to create queued agent session");
  }

  const [run] = await tx
    .insert(agentRuns)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      agentComposeVersionId: args.resolved.agentComposeVersionId,
      status: "queued",
      prompt: args.body.prompt,
      appendSystemPrompt: args.body.appendSystemPrompt ?? null,
      vars: args.body.vars ?? null,
      secretNames: args.body.secrets ? Object.keys(args.body.secrets) : null,
      additionalVolumes: args.additionalVolumes
        ? [...args.additionalVolumes]
        : null,
      resumedFromCheckpointId: args.resolved.resumedFromCheckpointId ?? null,
      continuedFromSessionId: args.resolved.continuedFromSessionId ?? null,
      sessionId,
      lastHeartbeatAt: nowDate(),
    })
    .returning({
      id: agentRuns.id,
      createdAt: agentRuns.createdAt,
      sessionId: agentRuns.sessionId,
    });

  if (!run) {
    throw new Error("Failed to create queued run record");
  }

  await insertZeroRunRecord(tx, {
    runId: run.id,
    body: args.body,
    modelProvider: args.modelProvider,
    chatThreadId: args.chatThreadId,
    zeroRunMetadata: args.zeroRunMetadata,
  });

  if (args.callbacks && args.callbacks.length > 0) {
    await tx.insert(agentRunCallbacks).values(
      args.callbacks.map((callback) => {
        return {
          runId: run.id,
          url: callback.url,
          encryptedSecret: encryptSecretValue(callback.secret),
          payload: callback.payload,
        };
      }),
    );
  }

  return { ...run, status: "queued" };
}

function buildStoredExecutionContext(args: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly resolved: ResolvedCompose;
  readonly body: CreateRunBody;
  readonly framework: SupportedFramework;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly apiStartTime: number;
  readonly storageManifest: StorageManifest;
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly extraEnvironment: Record<string, string> | undefined;
}): BuiltStoredExecutionContext {
  const permissions = buildPermissionManifest({
    modelProvider: args.modelProvider,
    permissionPolicies: args.body.permissionPolicies,
    vars: args.body.vars,
    connectorTypes: args.connectorContext.connectorTypes,
    customConnectorFirewalls: args.customConnectorContext.firewalls,
  });
  const executionSecrets = buildStoredExecutionSecrets({
    connectorContext: args.connectorContext,
    modelProvider: args.modelProvider,
    bodySecrets: args.body.secrets,
    customConnectorContext: args.customConnectorContext,
  });
  const secretNames = executionSecrets.secrets
    ? Object.keys(executionSecrets.secrets)
    : [];
  const secretValues = executionSecrets.secrets
    ? Object.values(executionSecrets.secrets)
    : [];

  return {
    context: {
      workingDir: frameworkWorkingDir(args.framework),
      storageManifest: args.storageManifest,
      environment: {
        ...expandEnvironment(
          args.resolved.content,
          args.body.vars,
          executionSecrets.secrets,
          args.modelProvider?.environment,
        ),
        ...args.extraEnvironment,
      },
      resumeSession: args.resolved.resumeSession ?? null,
      encryptedSecrets: encryptSecretsMap(executionSecrets.secrets ?? null),
      secretConnectorMap: executionSecrets.secretConnectorMap,
      secretConnectorMetadataMap: executionSecrets.secretConnectorMetadataMap,
      cliAgentType: args.framework,
      debugNoMockClaude: args.body.debugNoMockClaude || undefined,
      debugNoMockCodex: args.body.debugNoMockCodex || undefined,
      captureNetworkBodies: args.body.captureNetworkBodies || undefined,
      apiStartTime: args.apiStartTime,
      firewalls: permissions?.firewalls,
      networkPolicies: permissions?.networkPolicies,
      disallowedTools: args.body.disallowedTools,
      tools: args.body.tools,
      settings: args.body.settings,
      experimentalProfile: runnerProfile(args.resolved.content),
      featureFlags: {},
      billableFirewalls: billableFirewallsForPermissions({
        modelProvider: args.modelProvider,
        permissions,
      }),
      modelUsageProvider: modelUsageProviderForContext(args.modelProvider),
    },
    secretNames,
    secretValues,
  };
}

function sanitizeEnvironment(
  environment: Record<string, string> | null | undefined,
  secretValues: readonly string[],
): Record<string, string> {
  const secrets = new Set(secretValues);
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    sanitized[key] = secrets.has(value) ? "***" : value;
  }
  return sanitized;
}

function sanitizeFirewalls(
  firewalls: Firewalls | null | undefined,
): RunContextResponse["firewalls"] {
  if (!firewalls) {
    return [];
  }
  return firewalls.map((firewall) => {
    return {
      name: firewall.name,
      apis: firewall.apis.map((api) => {
        return {
          base: api.base,
          permissions: api.permissions?.map((permission) => {
            return {
              name: permission.name,
              description: permission.description,
              rules: permission.rules,
            };
          }),
        };
      }),
    };
  });
}

function ingestRunContextSnapshot(args: {
  readonly runId: string;
  readonly userId: string;
  readonly body: CreateRunBody;
  readonly builtContext: BuiltStoredExecutionContext;
}): void {
  const storedContext = args.builtContext.context;
  const manifest = storedContext.storageManifest;
  const snapshot: RunContextSnapshot & { readonly _time: string } = {
    _time: nowDate().toISOString(),
    runId: args.runId,
    userId: args.userId,
    prompt: args.body.prompt,
    appendSystemPrompt: args.body.appendSystemPrompt ?? null,
    sessionId: storedContext.resumeSession?.sessionId ?? null,
    secretNames: [...args.builtContext.secretNames],
    environment: sanitizeEnvironment(
      storedContext.environment,
      args.builtContext.secretValues,
    ),
    firewalls: sanitizeFirewalls(storedContext.firewalls),
    networkPolicies: storedContext.networkPolicies ?? null,
    volumes: (manifest?.storages ?? []).map((storage) => {
      return {
        name: storage.name,
        mountPath: storage.mountPath,
        vasStorageName: storage.vasStorageName,
        vasVersionId: storage.vasVersionId,
      };
    }),
    artifact:
      manifest && manifest.artifacts.length > 0
        ? {
            mountPath: manifest.artifacts[0]!.mountPath,
            vasStorageName: manifest.artifacts[0]!.vasStorageName,
            vasVersionId: manifest.artifacts[0]!.vasVersionId,
          }
        : null,
    featureFlags: storedContext.featureFlags ?? null,
  };

  ingestToAxiom(getDatasetName("run-context"), [snapshot]);
}

function buildStoredExecutionSecrets(args: {
  readonly connectorContext: ConnectorRuntimeContext;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly bodySecrets: Record<string, string> | undefined;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
}): StoredExecutionSecrets {
  const platformSecrets = injectPlatformEnvSecrets(
    args.connectorContext.connectorTypes,
  );
  const filteredConnectorMap = filterSecretConnectorMap({
    secretConnectorMap: args.connectorContext.secretConnectorMap,
    overriddenSecrets: [
      args.modelProvider?.secrets,
      args.bodySecrets,
      args.customConnectorContext.secrets,
      platformSecrets,
    ],
  });

  return {
    secrets: mergeRecords(
      args.connectorContext.secrets,
      args.modelProvider?.secrets,
      args.bodySecrets,
      args.customConnectorContext.secrets,
      platformSecrets,
    ),
    secretConnectorMap:
      mergeRecords(
        filteredConnectorMap,
        args.modelProvider?.secretConnectorMap,
      ) ?? null,
    secretConnectorMetadataMap:
      args.modelProvider?.secretConnectorMetadataMap ?? null,
  };
}

function billableFirewallsForPermissions(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly permissions: PermissionManifest | undefined;
}): string[] {
  const billableConnectorSet = new Set<string>(BILLABLE_CONNECTORS);
  const firewalls = args.permissions?.firewalls ?? [];
  const modelFirewalls =
    args.modelProvider?.type === "vm0"
      ? firewalls.filter((firewall) => {
          return firewall.name.startsWith("model-provider:");
        })
      : [];
  const connectorFirewalls = firewalls.filter((firewall) => {
    return billableConnectorSet.has(firewall.name);
  });

  return [...modelFirewalls, ...connectorFirewalls].map((firewall) => {
    return firewall.name;
  });
}

function modelUsageProviderForContext(
  modelProvider: ResolvedModelProviderEnvironment | null,
): string | undefined {
  return modelProvider?.type === "vm0"
    ? (modelProvider.selectedModel ?? undefined)
    : undefined;
}

async function markRunFailed(
  db: Db,
  runId: string,
  error: unknown,
): Promise<boolean> {
  const message = error instanceof Error ? error.message : "Run failed";
  const [updated] = await db
    .update(agentRuns)
    .set({
      status: "failed",
      error: message,
      completedAt: nowDate(),
    })
    .where(
      and(
        eq(agentRuns.id, runId),
        or(
          eq(agentRuns.status, "queued"),
          eq(agentRuns.status, "pending"),
          eq(agentRuns.status, "running"),
        ),
      ),
    )
    .returning({
      userId: agentRuns.userId,
    });

  if (!updated) {
    return false;
  }

  await publishRunChangedForUserSafely(updated.userId, runId, {
    status: "failed",
  });
  await dispatchRunCallbacks(db, runId, "failed", undefined, message).catch(
    (error: unknown) => {
      L.error("Failed to dispatch failed-run callbacks", { runId, error });
    },
  );
  return true;
}

async function buildRunnerJobPayload(
  get: ComputedGetter,
  db: Db,
  args: {
    readonly run: RunRecord;
    readonly userId: string;
    readonly orgId: string;
    readonly resolved: ResolvedCompose;
    readonly body: CreateRunBody;
    readonly artifacts: readonly ContextArtifact[];
    readonly framework: SupportedFramework;
    readonly modelProvider: ResolvedModelProviderEnvironment | null;
    readonly connectorContext: ConnectorRuntimeContext;
    readonly customConnectorContext: CustomConnectorRuntimeContext;
    readonly apiStartTime: number;
    readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
    readonly includeZeroTokenSecret: boolean | undefined;
    readonly extraEnvironment: Record<string, string> | undefined;
  },
): Promise<ReturnType<typeof queuedRunnerJobPayload>> {
  const group =
    runnerGroup(args.resolved.content) ?? optionalEnv("RUNNER_DEFAULT_GROUP");
  if (!group) {
    throw new Error("No executor configured: set RUNNER_DEFAULT_GROUP");
  }
  if (!isOfficialRunnerGroup(group)) {
    throw new Error("Only vm0/* runner groups are supported");
  }

  const profile = runnerProfile(args.resolved.content);
  const featureSwitchOverrides = args.includeZeroTokenSecret
    ? await get(userFeatureSwitchOverrides(args.orgId, args.userId))
    : undefined;
  const body = args.includeZeroTokenSecret
    ? withZeroTokenSecret(
        args.body,
        generateZeroToken(
          args.userId,
          args.run.id,
          args.orgId,
          featureSwitchOverrides,
        ),
      )
    : args.body;
  const storageManifest = await prepareAgentRunStorageManifest({
    get,
    db,
    content: args.resolved.content,
    vars: body.vars,
    agentOrgId: args.resolved.orgId,
    runtimeOrgId: args.orgId,
    userId: args.userId,
    artifacts: args.artifacts,
    volumeVersionOverrides: args.resolved.volumeVersions,
    additionalVolumes: args.additionalVolumes,
    framework: args.framework,
  });
  const builtContext = buildStoredExecutionContext({
    ...args,
    body,
    runId: args.run.id,
    storageManifest,
  });
  ingestRunContextSnapshot({
    runId: args.run.id,
    userId: args.userId,
    body,
    builtContext,
  });
  const storedContext = builtContext.context;
  return queuedRunnerJobPayload({
    runnerGroup: group,
    profile,
    sessionId: storedContext.resumeSession?.sessionId ?? null,
    executionContext: storedContext,
  });
}

async function dispatchRun(
  get: ComputedGetter,
  db: Db,
  args: {
    readonly run: RunRecord;
    readonly userId: string;
    readonly orgId: string;
    readonly resolved: ResolvedCompose;
    readonly body: CreateRunBody;
    readonly artifacts: readonly ContextArtifact[];
    readonly framework: SupportedFramework;
    readonly modelProvider: ResolvedModelProviderEnvironment | null;
    readonly connectorContext: ConnectorRuntimeContext;
    readonly customConnectorContext: CustomConnectorRuntimeContext;
    readonly apiStartTime: number;
    readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
    readonly includeZeroTokenSecret: boolean | undefined;
    readonly extraEnvironment: Record<string, string> | undefined;
  },
): Promise<{ readonly status: RunStatus; readonly sandboxId?: string }> {
  await db
    .update(agentRuns)
    .set({ lastHeartbeatAt: nowDate() })
    .where(and(eq(agentRuns.id, args.run.id), eq(agentRuns.status, "pending")));

  const payload = await buildRunnerJobPayload(get, db, args);

  await db.insert(runnerJobQueue).values({
    runId: args.run.id,
    runnerGroup: payload.runnerGroup,
    profile: payload.profile,
    sessionId: payload.sessionId,
    executionContext: payload.executionContext,
    expiresAt: new Date(now() + 2 * 60 * 60 * 1000),
  });

  await db
    .update(agentRuns)
    .set({ runnerGroup: payload.runnerGroup })
    .where(eq(agentRuns.id, args.run.id));

  await notifyRunnerJob(db, {
    runnerGroup: payload.runnerGroup,
    runId: args.run.id,
    profile: payload.profile,
    sessionId: payload.sessionId,
  });

  return { status: "pending" };
}

async function enqueueRunForConcurrency(
  get: ComputedGetter,
  db: Db,
  args: {
    readonly run: RunRecord;
    readonly userId: string;
    readonly orgId: string;
    readonly resolved: ResolvedCompose;
    readonly body: CreateRunBody;
    readonly artifacts: readonly ContextArtifact[];
    readonly framework: SupportedFramework;
    readonly modelProvider: ResolvedModelProviderEnvironment | null;
    readonly connectorContext: ConnectorRuntimeContext;
    readonly customConnectorContext: CustomConnectorRuntimeContext;
    readonly apiStartTime: number;
    readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
    readonly includeZeroTokenSecret: boolean | undefined;
    readonly extraEnvironment: Record<string, string> | undefined;
  },
): Promise<void> {
  const payload = await buildRunnerJobPayload(get, db, args);
  await db.insert(agentRunQueue).values({
    runId: args.run.id,
    userId: args.userId,
    orgId: args.orgId,
    encryptedParams: encryptQueuedRunnerJobPayload(payload),
    createdAt: args.run.createdAt,
    expiresAt: new Date(now() + QUEUED_RUN_TTL_MS),
  });
  await db
    .update(agentRuns)
    .set({ runnerGroup: payload.runnerGroup })
    .where(eq(agentRuns.id, args.run.id));
  await publishOrgSignal(args.orgId, "queue:changed");
}

function createdRunResponse(
  run: RunRecord,
  dispatchResult: { readonly status: RunStatus; readonly sandboxId?: string },
): Extract<CreateRunRouteResult, { readonly status: 201 }> {
  return {
    status: 201,
    body: {
      runId: run.id,
      status: dispatchResult.status,
      sandboxId: dispatchResult.sandboxId,
      sessionId: run.sessionId,
      createdAt: run.createdAt.toISOString(),
    },
  };
}

function failedRunResponse(
  run: RunRecord,
  error: unknown,
): Extract<CreateRunRouteResult, { readonly status: 201 }> {
  return {
    status: 201,
    body: {
      runId: run.id,
      status: "failed",
      sessionId: run.sessionId,
      error: error instanceof Error ? error.message : "Run failed",
      createdAt: run.createdAt.toISOString(),
    },
  };
}

interface PreparedRunContext {
  readonly body: CreateRunBody;
  readonly resolved: ResolvedCompose;
  readonly framework: SupportedFramework;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly artifacts: readonly ContextArtifact[];
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
}

async function resolveRunModelProvider(
  db: Db,
  args: CreateAgentRunArgs,
  content: AgentComposeContent,
  framework: SupportedFramework,
  signal: AbortSignal,
): Promise<ResolvedModelProviderEnvironment | null | CreateRunErrorResult> {
  const hasFrameworkKey = hasExplicitFrameworkApiKey(content, framework);
  const hasProviderOverride =
    args.modelProviderId !== undefined ||
    args.modelProviderCredentialScope !== undefined;
  const shouldResolveModelProvider =
    hasProviderOverride || !hasFrameworkKey || args.modelProviderType === "vm0";
  const modelProvider = shouldResolveModelProvider
    ? await resolveModelProviderEnvironment(db, {
        orgId: args.orgId,
        userId: args.userId,
        framework,
        modelProviderId: args.modelProviderId,
        modelProviderCredentialScope: args.modelProviderCredentialScope,
        modelProviderType: args.modelProviderType,
        selectedModelOverride: args.selectedModelOverride,
      })
    : null;
  signal.throwIfAborted();

  if (!shouldResolveModelProvider || modelProvider) {
    return modelProvider;
  }

  if (args.enforceVm0Credits && args.modelProviderType === "vm0") {
    const creditGate = await checkVm0Credits(db, {
      userId: args.userId,
      orgId: args.orgId,
    });
    signal.throwIfAborted();
    if (creditGate) {
      return creditGate;
    }
  }

  return providerUnavailable(
    `No model provider configured and ${frameworkApiKeyEnv(framework)} is not declared in compose environment`,
  );
}

async function prepareRunContext(
  get: ComputedGetter,
  db: Db,
  args: CreateAgentRunArgs,
  signal: AbortSignal,
): Promise<PreparedRunContext | CreateRunErrorResult> {
  const initialBody = args.includeZeroTokenSecret
    ? withPendingZeroTokenSecret(args.body)
    : args.body;

  const captureGate = await enforceCaptureNetworkBodiesGate(
    db,
    args.userId,
    initialBody.captureNetworkBodies,
  );
  signal.throwIfAborted();
  if (captureGate) {
    return captureGate;
  }

  const mergedVars = await loadMergedVariables(db, {
    orgId: args.orgId,
    userId: args.userId,
    runVars: initialBody.vars,
  });
  signal.throwIfAborted();
  let body: CreateRunBody = { ...initialBody, vars: mergedVars };

  const resolved = await resolveCompose(get, db, body, args.userId, args.orgId);
  signal.throwIfAborted();
  if (isRouteError(resolved)) {
    return resolved;
  }

  if (resolved.orgId !== args.orgId) {
    return notFound("Resource not found");
  }

  const mergedSecrets = await loadReferencedSecrets(db, {
    orgId: args.orgId,
    userId: args.userId,
    content: resolved.content,
    runSecrets: body.secrets,
    allowedConnectorTypes: args.allowedConnectorTypes,
  });
  signal.throwIfAborted();
  body = { ...body, secrets: mergedSecrets };

  const validation = validateCompose(
    resolved.content,
    body.vars,
    body.secrets,
    {
      validateEnvironmentReferences: args.validateEnvironmentReferences,
    },
  );
  if (isRouteError(validation)) {
    return validation;
  }

  const requestedFramework = await resolveRequestedRunFramework(
    db,
    args,
    validation.framework,
  );
  signal.throwIfAborted();

  const modelProvider = await resolveRunModelProvider(
    db,
    args,
    resolved.content,
    requestedFramework,
    signal,
  );
  if (isRouteError(modelProvider)) {
    return modelProvider;
  }
  const framework = modelProvider
    ? modelProviderFramework(modelProvider)
    : requestedFramework;

  const [
    oauthConnectorContext,
    apiTokenConnectorTypes,
    customConnectorContext,
  ] = await Promise.all([
    loadOauthConnectorContext(db, {
      orgId: args.orgId,
      userId: args.userId,
      allowedConnectorTypes: args.allowedConnectorTypes,
    }),
    loadApiTokenConnectorTypes(db, {
      orgId: args.orgId,
      userId: args.userId,
    }),
    loadCustomConnectorContext(db, {
      orgId: args.orgId,
      userId: args.userId,
      allowedCustomConnectorIds: args.allowedCustomConnectorIds,
    }),
  ]);
  signal.throwIfAborted();
  const allowedApiTokenConnectorTypes = args.allowedConnectorTypes
    ? apiTokenConnectorTypes.filter((type) => {
        return args.allowedConnectorTypes?.includes(type);
      })
    : apiTokenConnectorTypes;
  const connectorContext: ConnectorRuntimeContext = {
    ...oauthConnectorContext,
    connectorTypes: [
      ...new Set([
        ...oauthConnectorContext.connectorTypes,
        ...allowedApiTokenConnectorTypes,
      ]),
    ],
  };

  const artifacts = artifactsForRun({
    resolved,
    framework,
    bodyArtifacts: body.artifacts,
  });
  const additionalVolumes = mergeAdditionalVolumes({
    prepend: buildInjectedSkillVolumes(args, framework),
    base: body.additionalVolumes ?? resolved.additionalVolumes,
  });

  return {
    body,
    resolved,
    framework,
    modelProvider,
    connectorContext,
    customConnectorContext,
    artifacts,
    additionalVolumes,
  };
}

async function insertRunWithConcurrency(
  db: Db,
  args: CreateAgentRunArgs,
  context: PreparedRunContext,
): Promise<RunRecord | CreateRunErrorResult> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${args.orgId}))`,
    );
    const concurrency = await checkRunConcurrencyLimit(tx, args.orgId);
    if (concurrency) {
      if (args.queueOnConcurrencyLimit) {
        return await insertQueuedRunRecord(tx, {
          userId: args.userId,
          orgId: args.orgId,
          resolved: context.resolved,
          body: context.body,
          artifacts: context.artifacts,
          additionalVolumes: context.additionalVolumes,
          modelProvider: context.modelProvider,
          callbacks: args.callbacks,
          chatThreadId: args.chatThreadId,
          zeroRunMetadata: args.zeroRunMetadata,
        });
      }
      return concurrency;
    }
    return await insertRunRecord(tx, {
      userId: args.userId,
      orgId: args.orgId,
      resolved: context.resolved,
      body: context.body,
      artifacts: context.artifacts,
      additionalVolumes: context.additionalVolumes,
      modelProvider: context.modelProvider,
      callbacks: args.callbacks,
      chatThreadId: args.chatThreadId,
      zeroRunMetadata: args.zeroRunMetadata,
    });
  });
}

async function completeQueuedRun(input: {
  readonly get: ComputedGetter;
  readonly db: Db;
  readonly args: CreateAgentRunArgs;
  readonly context: PreparedRunContext;
  readonly run: RunRecord;
  readonly signal: AbortSignal;
}): Promise<Extract<CreateRunRouteResult, { readonly status: 201 }>> {
  const enqueueResult = await safeAsync(() => {
    return enqueueRunForConcurrency(input.get, input.db, {
      run: input.run,
      userId: input.args.userId,
      orgId: input.args.orgId,
      resolved: input.context.resolved,
      body: input.context.body,
      artifacts: input.context.artifacts,
      framework: input.context.framework,
      modelProvider: input.context.modelProvider,
      connectorContext: input.context.connectorContext,
      customConnectorContext: input.context.customConnectorContext,
      apiStartTime: input.args.apiStartTime,
      additionalVolumes: input.context.additionalVolumes,
      includeZeroTokenSecret: input.args.includeZeroTokenSecret,
      extraEnvironment: input.args.extraEnvironment,
    });
  });
  input.signal.throwIfAborted();
  if (!("ok" in enqueueResult)) {
    await markRunFailed(input.db, input.run.id, enqueueResult.error);
    input.signal.throwIfAborted();
    return failedRunResponse(input.run, enqueueResult.error);
  }
  return createdRunResponse(input.run, { status: "queued" });
}

async function completePendingRun(input: {
  readonly get: ComputedGetter;
  readonly db: Db;
  readonly args: CreateAgentRunArgs;
  readonly context: PreparedRunContext;
  readonly run: RunRecord;
  readonly drainOrgQueue: () => Promise<void>;
  readonly signal: AbortSignal;
}): Promise<Extract<CreateRunRouteResult, { readonly status: 201 }>> {
  const dispatchResult = await safeAsync(() => {
    return dispatchRun(input.get, input.db, {
      run: input.run,
      userId: input.args.userId,
      orgId: input.args.orgId,
      resolved: input.context.resolved,
      body: input.context.body,
      artifacts: input.context.artifacts,
      framework: input.context.framework,
      modelProvider: input.context.modelProvider,
      connectorContext: input.context.connectorContext,
      customConnectorContext: input.context.customConnectorContext,
      apiStartTime: input.args.apiStartTime,
      additionalVolumes: input.context.additionalVolumes,
      includeZeroTokenSecret: input.args.includeZeroTokenSecret,
      extraEnvironment: input.args.extraEnvironment,
    });
  });
  input.signal.throwIfAborted();

  if ("ok" in dispatchResult) {
    return createdRunResponse(input.run, dispatchResult.ok);
  }

  const transitioned = await markRunFailed(
    input.db,
    input.run.id,
    dispatchResult.error,
  );
  input.signal.throwIfAborted();
  if (transitioned) {
    await input.drainOrgQueue().catch((error: unknown) => {
      L.error("Failed to drain org queue after run dispatch failure", {
        runId: input.run.id,
        error,
      });
    });
    input.signal.throwIfAborted();
  }
  return failedRunResponse(input.run, dispatchResult.error);
}

export const createAgentRun$ = command(
  async (
    { get, set },
    args: CreateAgentRunArgs,
    signal: AbortSignal,
  ): Promise<CreateRunRouteResult> => {
    const db = set(writeDb$);
    const context = await prepareRunContext(get, db, args, signal);
    if (isRouteError(context)) {
      return context;
    }

    if (args.enforceVm0Credits && context.modelProvider?.type === "vm0") {
      const creditGate = await checkVm0Credits(db, {
        userId: args.userId,
        orgId: args.orgId,
      });
      signal.throwIfAborted();
      if (creditGate) {
        return creditGate;
      }
    }

    const transactionResult = await insertRunWithConcurrency(db, args, context);
    signal.throwIfAborted();

    if (isRouteError(transactionResult)) {
      return transactionResult;
    }

    if (transactionResult.status === "queued") {
      return await completeQueuedRun({
        get,
        db,
        args,
        context,
        run: transactionResult,
        signal,
      });
    }

    return await completePendingRun({
      get,
      db,
      args,
      context,
      run: transactionResult,
      drainOrgQueue: async () => {
        await set(drainOrgQueue$, { orgId: args.orgId }, signal);
      },
      signal,
    });
  },
);
