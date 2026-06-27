import { command, computed, type Computed } from "ccstate";
import {
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  DEFAULT_PROFILE,
  type SecretConnectorMetadata,
  type StorageManifest,
  type StoredExecutionContext,
} from "@vm0/api-contracts/contracts/runners";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import {
  getDefaultModel,
  getModelProviderFirewall,
  getModelProviderEnvBindings,
  getFrameworkForType,
  getProviderRuntimeModel,
  getSecretNameForType,
  getSecretsForAuthMethod,
  getVm0ConcreteProviderType,
  getVm0Vendor,
  hasAuthMethods,
  isSupportedRunModel,
  MODEL_PROVIDER_TYPES,
  normalizeRunModelId,
  type ModelProviderEnvBindings,
  type ModelProviderCredentialScope,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  getConnectorAuthMethod,
  getConnectorAuthMethodRuntimeMetadata,
  type ConnectorRuntimeBindingEntry,
} from "@vm0/connectors/connector-utils";
import {
  connectorTypeSchema,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  getFirewallExecutionMetadata,
  isFirewallExecutionMetadataConnectorType,
  loadFirewallPermissionIndex,
  type FirewallExecutionMetadata,
  type FirewallExecutionMetadataConnectorType,
  type FirewallPermissionIndex,
} from "@vm0/connectors/firewall-metadata/server";
import { getModelProviderRefreshMetadata } from "@vm0/connectors/auth-providers/model-provider-auth";
import {
  extractSecretNamesFromApis,
  resolveFirewallBaseUrlVars,
  type ExecutionFirewallEntry,
  type ExecutionFirewalls,
  type ExpandedFirewallConfig,
  FirewallBaseUrlResolutionError,
  type Firewall,
  type FirewallPolicies,
  type FirewallPolicy,
  type NetworkPolicies,
} from "@vm0/connectors/firewall-types";
import {
  type CreateRunResponse,
  type RunStatus,
  runStatusSchema,
  unifiedRunRequestSchema,
} from "@vm0/api-contracts/contracts/runs";
import {
  isSupportedFramework,
  type SupportedFramework,
} from "@vm0/core/frameworks";
import {
  getAllFeatureStates,
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { resolveSkillRef, parseGitHubTreeUrl } from "@vm0/core/github-url";
import {
  getCustomSkillStorageName,
  getSkillStorageName,
  MEMORY_ARTIFACT_NAME,
} from "@vm0/core/storage-names";
import { SEED_SKILLS, GOAL_SKILL_NAME } from "@vm0/core/zero-seed-skills";
import {
  expandVariables,
  expandVariablesInString,
  extractAndGroupVariables,
} from "@vm0/core/variable-expander";
import { expandMountPath } from "@vm0/api-contracts/contracts/composes";
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
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
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
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import {
  publishOrgSignal,
  publishRunChangedForUserSafely,
} from "../external/realtime";
import { now, nowDate } from "../external/time";
import { generateZeroToken } from "../auth/tokens";
import { onRejection, settle, tapError } from "../utils";
import {
  environmentRecordToEntries,
  featureFlagsRecordToEntries,
  networkPoliciesRecordToEntries,
  type RunContextAxiomSnapshot,
} from "./run-context-snapshot.service";
import {
  decryptStoredSecretValue,
  encryptPersistentSecretValue,
  encryptPersistentSecretsMap,
} from "./crypto.utils";
import {
  customConnectorInternalName,
  customConnectorSecretKey,
  decryptCustomConnectorValues,
  loadCustomConnectorRuntimeData,
  renderCustomConnectorRuntimePrefix,
  renderTemplateForRuntime,
} from "./zero-custom-connector.service";
import { prepareAgentRunStorageManifest } from "./agent-run-storage.service";
import {
  encryptQueuedRunnerJobPayload,
  queuedRunnerJobPayload,
} from "./agent-run-queue-payload.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { drainOrgQueue$ } from "./zero-run-queue.service";
import { notifyRunnerJob } from "./runner-dispatch.service";
import {
  connectorRuntimeCredentialStatus,
  type ConnectorCredentialStatus,
} from "./connector-credential-status.service";
import { logger } from "../../lib/log";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import {
  activePaidConcurrencySlots,
  cappedBaseConcurrencyLimit,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import { checkLimitedFreeRunModelAdmission } from "./zero-run-admission.service";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
  type ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";
import {
  loadAgentConnectorScope,
  loadZeroBackedComposeAgent,
} from "./agent-connector-scope.service";

const PENDING_RUN_TTL_MS = 15 * 60 * 1000;
const QUEUED_RUN_TTL_MS = 2 * 60 * 60 * 1000;
const AUTO_MEMORY_ARTIFACT_NAME = MEMORY_ARTIFACT_NAME;
type ArtifactMissingRootPolicy = NonNullable<
  StorageManifest["artifacts"][number]["missingRootPolicy"]
>;
const AUTO_MEMORY_MISSING_ROOT_POLICY: ArtifactMissingRootPolicy =
  "preserveParentVersion";
const STORED_CONNECTOR_SECRET_DECRYPT_CONCURRENCY = 4;

const TIER_LIMITS = Object.freeze({
  free: 1,
  "limited-free-1": 1,
  pro: 2,
  team: 10,
});

function getEffectiveConcurrencyLimit(
  tier: keyof typeof TIER_LIMITS,
  paidSlots: number,
): number {
  const limit = totalConcurrencyLimit({
    baseLimit: cappedBaseConcurrencyLimit(TIER_LIMITS[tier]),
    paidSlots,
  });
  return Number.isFinite(limit) ? limit : 0;
}

const ORG_SENTINEL_USER_ID = "__org__";
const L = logger("AgentRunCreate");
const CONNECTOR_SECRET_REF_PREFIX = "$secrets.";
const CONNECTOR_VAR_REF_PREFIX = "$vars.";
const DEFAULT_FIREWALL_SECRET_PLACEHOLDER =
  "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe";
const STORED_CONNECTOR_COUNT_BUCKET_DIMENSIONS = [
  "0",
  "1",
  "2_4",
  "5_8",
  "9_16",
  "17_plus",
] as const;

type CreateRunBody = z.infer<typeof unifiedRunRequestSchema>;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type RunAdmissionDb = Pick<Db, "select">;

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
  readonly missingRootPolicy?: ArtifactMissingRootPolicy;
}

interface RunArtifacts {
  readonly artifacts: readonly ContextArtifact[];
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
  // Run provenance: the automation + the trigger that fired this run (set by the
  // webhook inbound path). Persisted as first-class zero_runs columns.
  readonly automationId?: string;
  readonly triggerId?: string;
  // Run provenance for workflow schedule triggers.
  readonly workflowTriggerId?: string;
  // Stable chat run-group key for automation/workflow/goal-triggered runs.
  readonly runGroupId?: string;
  // Run provenance for autonomous thread-goal continuation.
  readonly goalId?: string;
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
  readonly vars?: Record<string, string>;
  readonly volumeVersions?: Record<string, string>;
  readonly additionalVolumes?: readonly AdditionalVolume[];
  readonly agentSessionId?: string;
  readonly resumedFromCheckpointId?: string;
  readonly continuedFromAgentSessionId?: string;
  readonly resumeSession?: StoredExecutionContext["resumeSession"];
}

type ConnectorScopeSource =
  | "explicit"
  | "zero_agent"
  | "zero_unattended"
  | "legacy_all"
  | "empty";

interface EffectiveConnectorScope {
  readonly allowedConnectorTypes: readonly ConnectorType[] | undefined;
  readonly allowedCustomConnectorIds: readonly string[] | undefined;
  readonly source: ConnectorScopeSource;
}

interface ExplicitConnectorScope {
  readonly allowedConnectorTypes: readonly ConnectorType[];
  readonly allowedCustomConnectorIds: readonly string[];
  readonly source?: Exclude<ConnectorScopeSource, "legacy_all" | "empty">;
}

// Session naming in this service:
// - agentSessionId is the vm0 application session (`agent_sessions.id`) used
//   for product-level continuation and future correctness checks.
// - cliAgentSessionId is the Claude/Codex CLI agent session stored on
//   `conversations.cli_agent_session_id`; runner sandbox reuse is keyed by it.
// Existing API/runner wire fields named `sessionId` are preserved for
// compatibility and normalized to these semantic names at the boundary.

interface RunRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly sessionId: string;
  readonly status: "pending" | "queued";
}

interface LockedRunPersistenceRow extends Record<string, unknown> {
  readonly status: string;
  readonly sandboxId: string | null;
}

interface DerivedPersistenceResult {
  readonly status: RunStatus;
  readonly sandboxId?: string;
}

interface HttpRunCallback {
  readonly url: string;
  readonly secret: string;
  readonly payload: unknown;
}

interface InternalRunCallback {
  readonly internalKind: InternalRunCallbackKind;
  readonly secret: string;
  readonly payload: unknown;
}

type RunCallback = HttpRunCallback | InternalRunCallback;

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
  readonly firewalls: ExecutionFirewalls;
  readonly networkPolicies: NetworkPolicies;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly billableFirewalls: readonly string[];
}

interface ModelUsageContext {
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
}

interface StoredExecutionSecrets {
  // Runtime secret namespace encrypted into executionContext.encryptedSecrets.
  // Keys are the `NAME` in `${{ secrets.NAME }}`; connector/model-provider
  // entries use env aliases, not backing storage secret names.
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
  // Plain secret values used for run-context redaction; values, not names.
  readonly secretValues: readonly string[];
}

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

export type DispatchFailedRunCallbacks = (
  db: Db,
  runId: string,
  error: string,
) => Promise<void>;

export interface CreateAgentRunArgs {
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
  readonly zeroTokenComputerUseHostId?: string;
  readonly extraEnvironment?: Record<string, string>;
  // When set, system + workflow skill volumes are built and prepended in
  // prepareRunContext using the run's resolved (model-provider) framework.
  readonly injectSkillVolumes?: {
    // Each workflow's volume is keyed by its id (storage name), while the skill
    // mounts at its slug. Slugs are not unique, so the id is required.
    readonly workflows: readonly {
      readonly name: string;
      readonly workflowId: string;
    }[];
  };
  readonly connectorScope?: ExplicitConnectorScope;
  readonly validateEnvironmentReferences?: boolean;
  readonly zeroRunMetadata?: ZeroRunMetadata;
  readonly queueOnConcurrencyLimit?: boolean;
  readonly enforceVm0Credits?: boolean;
  readonly dispatchFailedCallbacks?: DispatchFailedRunCallbacks;
  readonly timing?: ApiDispatchTimingCollector;
}

interface ConnectorRuntimeContext {
  readonly secrets: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly connectorTypes: readonly ConnectorType[];
  readonly storedEnvironment: Record<string, string> | undefined;
}

interface PersistedRunEnvironmentSecret {
  readonly name: string;
  readonly encryptedValue: string;
  readonly userId: string;
}

interface PersistedRunEnvironmentVariable {
  readonly name: string;
  readonly value: string;
  readonly userId: string;
}

interface PersistedRunEnvironmentSnapshot {
  readonly secrets: readonly PersistedRunEnvironmentSecret[];
  readonly variables: readonly PersistedRunEnvironmentVariable[];
}

interface CreditCheckRow extends Record<string, unknown> {
  readonly tier: string | null;
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
// The harness ships a built-in `/goal` (Claude Code & Codex). When the vm0
// `goal` seed skill is injected it must take over, so these built-in goal tool
// identifiers are added to the run's disallowed-tools list to suppress the
// native command. Disallowing a name the active harness does not expose is a
// harmless no-op, so both harnesses' identifiers are listed.
const BUILTIN_GOAL_DISALLOWED_TOOLS = ["goal", "update_goal"] as const;

function withBuiltinGoalDisabled(
  disallowedTools: string[] | undefined,
  goalSeedEnabled: boolean,
): string[] | undefined {
  if (!goalSeedEnabled) {
    return disallowedTools;
  }
  return [
    ...new Set([...(disallowedTools ?? []), ...BUILTIN_GOAL_DISALLOWED_TOOLS]),
  ];
}

function buildSystemSkillVolumes(
  connectorTypes: readonly ConnectorType[],
  framework: SupportedFramework,
  goalSeedEnabled: boolean,
): readonly AdditionalVolume[] {
  // The `goal` skill is mounted only when the GoalWorkflows switch is on, so it
  // is appended here rather than living in the always-on SEED_SKILLS list.
  const seedNames = goalSeedEnabled
    ? [...SEED_SKILLS, GOAL_SKILL_NAME]
    : SEED_SKILLS;
  const allSkillNames = [...new Set([...seedNames, ...connectorTypes])];
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

function buildWorkflowSkillVolumes(
  workflows: readonly { readonly name: string; readonly workflowId: string }[],
  framework: SupportedFramework,
): readonly AdditionalVolume[] {
  return workflows
    .filter((workflow) => {
      return !SEED_SKILLS.includes(workflow.name);
    })
    .map((workflow) => {
      return {
        // The volume is keyed by the workflow id; it mounts at the slug.
        name: getCustomSkillStorageName(workflow.workflowId),
        mountPath: skillMountPath(framework, workflow.name),
      };
    });
}

function buildInjectedSkillVolumes(
  args: {
    readonly injectSkillVolumes: CreateAgentRunArgs["injectSkillVolumes"];
    readonly allowedConnectorTypes: readonly ConnectorType[] | undefined;
  },
  framework: SupportedFramework,
  goalSeedEnabled: boolean,
): readonly AdditionalVolume[] | undefined {
  if (!args.injectSkillVolumes) {
    return undefined;
  }
  return [
    ...buildSystemSkillVolumes(
      args.allowedConnectorTypes ?? [],
      framework,
      goalSeedEnabled,
    ),
    ...buildWorkflowSkillVolumes(args.injectSkillVolumes.workflows, framework),
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

function frameworkApiKeyEnv(framework: SupportedFramework): string {
  return framework === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

function autoMemoryMountPath(framework: SupportedFramework): string {
  return framework === "codex"
    ? CANONICAL_CODEX_MEMORY_MOUNT_PATH
    : CANONICAL_CLAUDE_MEMORY_MOUNT_PATH;
}

function autoMemoryArtifact(framework: SupportedFramework): ContextArtifact {
  return withAutoMemoryMissingRootPolicy({
    name: AUTO_MEMORY_ARTIFACT_NAME,
    mountPath: autoMemoryMountPath(framework),
  });
}

function isCanonicalAutoMemoryArtifact(
  artifact: ContextArtifact,
  framework: SupportedFramework,
): boolean {
  return (
    artifact.name === AUTO_MEMORY_ARTIFACT_NAME &&
    artifact.mountPath === autoMemoryMountPath(framework)
  );
}

function withAutoMemoryMissingRootPolicy(
  artifact: ContextArtifact,
): ContextArtifact {
  return {
    ...artifact,
    missingRootPolicy: AUTO_MEMORY_MISSING_ROOT_POLICY,
  };
}

function withCanonicalAutoMemoryMissingRootPolicy(
  artifacts: readonly ContextArtifact[],
  framework: SupportedFramework,
): readonly ContextArtifact[] {
  return artifacts.map((artifact) => {
    return isCanonicalAutoMemoryArtifact(artifact, framework)
      ? withAutoMemoryMissingRootPolicy(artifact)
      : artifact;
  });
}

function claimsAutoMemorySlot(
  artifact: ContextArtifact,
  framework: SupportedFramework,
): boolean {
  return (
    artifact.name === AUTO_MEMORY_ARTIFACT_NAME ||
    artifact.mountPath === autoMemoryMountPath(framework)
  );
}

function withoutSupersededAutoMemoryArtifacts(
  artifacts: readonly ContextArtifact[],
  framework: SupportedFramework,
  slotOwnerIndex: number,
): readonly ContextArtifact[] {
  return artifacts.filter((artifact, index) => {
    return (
      index >= slotOwnerIndex ||
      !isCanonicalAutoMemoryArtifact(artifact, framework)
    );
  });
}

function resolveComposeArtifactMountPath(artifact: ComposeArtifact): string {
  return expandMountPath(artifact.mount_path);
}

function composeArtifacts(
  content: AgentComposeContent,
): readonly ContextArtifact[] {
  return (content.artifacts ?? []).map((artifact) => {
    return {
      name: artifact.name,
      version: artifact.version,
      mountPath: resolveComposeArtifactMountPath(artifact),
    };
  });
}

function artifactsForRun(args: {
  readonly resolved: ResolvedCompose;
  readonly framework: SupportedFramework;
  readonly bodyArtifacts: readonly ContextArtifact[] | undefined;
}): RunArtifacts {
  const isContinuation =
    Boolean(args.resolved.agentSessionId) ||
    Boolean(args.resolved.resumedFromCheckpointId);
  const composeContextArtifacts = isContinuation
    ? []
    : composeArtifacts(args.resolved.content);
  const baseArtifacts = isContinuation
    ? args.resolved.artifacts
    : [...composeContextArtifacts, ...args.resolved.artifacts];
  const bodyArtifacts = args.bodyArtifacts ?? [];
  const artifacts = [...baseArtifacts, ...bodyArtifacts];

  let autoMemorySlotArtifactIndex: number | undefined;
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (artifact && claimsAutoMemorySlot(artifact, args.framework)) {
      autoMemorySlotArtifactIndex = index;
      break;
    }
  }
  if (autoMemorySlotArtifactIndex === undefined) {
    return {
      artifacts: [...artifacts, autoMemoryArtifact(args.framework)],
    };
  }

  const slotOwner = artifacts[autoMemorySlotArtifactIndex]!;
  if (!isCanonicalAutoMemoryArtifact(slotOwner, args.framework)) {
    return {
      artifacts: withoutSupersededAutoMemoryArtifacts(
        artifacts,
        args.framework,
        autoMemorySlotArtifactIndex,
      ),
    };
  }

  return {
    artifacts: withCanonicalAutoMemoryMissingRootPolicy(
      artifacts,
      args.framework,
    ),
  };
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

function connectorEnvironmentTemplate(
  envName: string,
  valueRef: string,
): string {
  if (valueRef.startsWith(CONNECTOR_SECRET_REF_PREFIX)) {
    return `\${{ secrets.${envName} }}`;
  }
  if (valueRef.startsWith(CONNECTOR_VAR_REF_PREFIX)) {
    return `\${{ vars.${envName} }}`;
  }
  return valueRef;
}

function addConnectorEnvironmentTemplate(
  environment: Record<string, string>,
  envName: string,
  valueRef: string,
): void {
  if (envName in environment) {
    return;
  }
  environment[envName] = connectorEnvironmentTemplate(envName, valueRef);
}

function environmentTemplates(args: {
  readonly content: AgentComposeContent;
  readonly additionalEnvironment: Record<string, string> | undefined;
}): Record<string, string> | undefined {
  const environment = firstAgent(args.content)?.environment;
  return mergeRecords(args.additionalEnvironment, environment);
}

function expandEnvironment(args: {
  readonly content: AgentComposeContent;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly additionalEnvironment: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly storedConnectorEnvironment: Record<string, string> | undefined;
  readonly connectorVars: Record<string, string> | undefined;
}): Record<string, string> | null {
  const storedConnectorEnvironment = expandStoredConnectorEnvironment({
    environment: effectiveStoredConnectorEnvironment({
      content: args.content,
      additionalEnvironment: args.additionalEnvironment,
      storedConnectorEnvironment: args.storedConnectorEnvironment,
    }),
    vars: args.connectorVars,
    secrets: args.secrets,
    environmentSecretPlaceholders: args.environmentSecretPlaceholders,
  });
  const mergedEnvironment = environmentTemplates({
    content: args.content,
    additionalEnvironment: args.additionalEnvironment,
  });
  if (!mergedEnvironment) {
    return storedConnectorEnvironment ?? null;
  }

  const { result } = expandVariables(mergedEnvironment, {
    vars: args.vars,
    secrets: {
      ...args.secrets,
      ...args.environmentSecretPlaceholders,
    },
  });
  return mergeRecords(result, storedConnectorEnvironment) ?? null;
}

function effectiveStoredConnectorEnvironment(args: {
  readonly content: AgentComposeContent;
  readonly additionalEnvironment: Record<string, string> | undefined;
  readonly storedConnectorEnvironment: Record<string, string> | undefined;
}): Record<string, string> | undefined {
  if (!args.storedConnectorEnvironment) {
    return undefined;
  }

  const overrides = mergeRecords(
    args.additionalEnvironment,
    firstAgent(args.content)?.environment,
  );
  if (!overrides) {
    return args.storedConnectorEnvironment;
  }

  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.storedConnectorEnvironment)) {
    if (overrides[key] === undefined) {
      environment[key] = value;
    }
  }
  return compactRecord(environment);
}

function expandStoredConnectorEnvironment(args: {
  readonly environment: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
}): Record<string, string> | undefined {
  if (!args.environment) {
    return undefined;
  }

  const expanded: Record<string, string> = {};
  const secretSources = mergeRecords(
    args.secrets,
    args.environmentSecretPlaceholders,
  );
  for (const [key, value] of Object.entries(args.environment)) {
    const expansion = expandVariablesInString(value, {
      vars: args.vars,
      secrets: secretSources,
    });
    if (expansion.missingVars.length > 0) {
      throw new Error(
        `Stored connector environment is missing required values: ${formatMissingReferences(expansion.missingVars)}`,
      );
    }
    expanded[key] = expansion.result;
  }
  return compactRecord(expanded);
}

function formatMissingReferences(
  refs: readonly { readonly source: string; readonly name: string }[],
): string {
  return refs
    .map((ref) => {
      return `${ref.source}.${ref.name}`;
    })
    .join(", ");
}

function firewallSecretPlaceholdersFromFirewalls(
  firewalls: readonly ExpandedFirewallConfig[] | undefined,
): Record<string, string> | undefined {
  if (!firewalls || firewalls.length === 0) {
    return undefined;
  }

  const placeholders: Record<string, string> = {};
  for (const firewall of firewalls) {
    const secretNames = extractSecretNamesFromApis(firewall.apis);
    for (const name of secretNames) {
      placeholders[name] =
        firewall.placeholders?.[name] ?? DEFAULT_FIREWALL_SECRET_PLACEHOLDER;
    }
    for (const [name, value] of Object.entries(firewall.placeholders ?? {})) {
      placeholders[name] = value;
    }
  }

  return Object.keys(placeholders).length > 0 ? placeholders : undefined;
}

function missingEnvironmentReferences(args: {
  readonly content: AgentComposeContent;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly additionalEnvironment: Record<string, string> | undefined;
  readonly storedConnectorEnvironment: Record<string, string> | undefined;
  readonly connectorVars: Record<string, string> | undefined;
}): string[] {
  assertStoredConnectorEnvironmentReferences({
    environment: effectiveStoredConnectorEnvironment({
      content: args.content,
      additionalEnvironment: args.additionalEnvironment,
      storedConnectorEnvironment: args.storedConnectorEnvironment,
    }),
    vars: args.connectorVars,
    secrets: args.secrets,
    environmentSecretPlaceholders: args.environmentSecretPlaceholders,
  });
  const environment = environmentTemplates({
    content: args.content,
    additionalEnvironment: args.additionalEnvironment,
  });
  const environmentMissing = missingReferencesInEnvironment({
    environment,
    vars: args.vars,
    secrets: args.secrets,
    environmentSecretPlaceholders: args.environmentSecretPlaceholders,
  });
  return environmentMissing;
}

function missingReferencesInEnvironment(args: {
  readonly environment: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
}): string[] {
  if (!args.environment) {
    return [];
  }
  const grouped = extractAndGroupVariables(args.environment);
  const missingVars = grouped.vars
    .filter((ref) => {
      return args.vars?.[ref.name] === undefined;
    })
    .map((ref) => {
      return `vars.${ref.name}`;
    });
  const missingSecrets = grouped.secrets
    .filter((ref) => {
      return (
        args.secrets?.[ref.name] === undefined &&
        args.environmentSecretPlaceholders?.[ref.name] === undefined
      );
    })
    .map((ref) => {
      return `secrets.${ref.name}`;
    });
  return [...missingVars, ...missingSecrets];
}

function assertStoredConnectorEnvironmentReferences(args: {
  readonly environment: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
}): void {
  const missing = missingReferencesInEnvironment(args);
  if (missing.length > 0) {
    throw new Error(
      `Stored connector environment is missing required values: ${missing.join(", ")}`,
    );
  }
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
  readonly envBindings: ModelProviderEnvBindings;
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
    "envBindings" in value &&
    typeof (value as { readonly secretName: unknown }).secretName === "string"
  );
}

function modelProviderEnvironmentSecretValue(
  type: ModelProviderType,
  secretName: string,
  secretValue: string,
): string {
  return getModelProviderFirewall(type)
    ? `\${{ secrets.${secretName} }}`
    : secretValue;
}

function hasUsableModelProviderSecretValue(value: string): boolean {
  return value.trim().length > 0;
}

function modelProviderEnvironment(
  id: string | null,
  type: ModelProviderType,
  config: SingleSecretModelProviderConfig,
  secretValue: string,
  selectedModel: string | null,
): ResolvedModelProviderEnvironment {
  const model = selectedModel ?? config.defaultModel ?? "";
  const runtimeModel = model ? getProviderRuntimeModel(type, model) : "";
  const environmentSecret = modelProviderEnvironmentSecretValue(
    type,
    config.secretName,
    secretValue,
  );
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.envBindings)) {
    environment[key] = value
      .replaceAll("$secret", environmentSecret)
      .replaceAll("$model", runtimeModel);
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
  secretName: string,
  secretValue: string,
  selectedModel: string | null,
): Record<string, string> {
  const envBindings = getModelProviderEnvBindings(type);
  if (!envBindings) {
    return {
      [secretName]: modelProviderEnvironmentSecretValue(
        type,
        secretName,
        secretValue,
      ),
    };
  }

  const model = selectedModel ?? MODEL_PROVIDER_TYPES[type].defaultModel ?? "";
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(envBindings)) {
    if (value === "$secret") {
      environment[key] = modelProviderEnvironmentSecretValue(
        type,
        secretName,
        secretValue,
      );
    } else if (value === "$model") {
      if (model) {
        environment[key] = model;
      }
    } else if (value.startsWith("$secrets.")) {
      const referencedSecret = value.slice("$secrets.".length);
      if (referencedSecret === secretName) {
        environment[key] = modelProviderEnvironmentSecretValue(
          type,
          referencedSecret,
          secretValue,
        );
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
  const envBindings = getModelProviderEnvBindings(type);
  if (!envBindings) {
    return Object.fromEntries(
      Object.entries(providerSecrets).map(([secretName, secretValue]) => {
        return [
          secretName,
          modelProviderEnvironmentSecretValue(type, secretName, secretValue),
        ];
      }),
    );
  }

  const fallbackSecret = Object.entries(providerSecrets)[0];
  const model = selectedModel ?? getDefaultModel(type) ?? "";
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(envBindings)) {
    if (value === "$secret") {
      if (fallbackSecret) {
        const [secretName, secretValue] = fallbackSecret;
        environment[key] = modelProviderEnvironmentSecretValue(
          type,
          secretName,
          secretValue,
        );
      }
    } else if (value === "$model") {
      if (model) {
        environment[key] = model;
      }
    } else if (value.startsWith("$secrets.")) {
      const secretName = value.slice("$secrets.".length);
      const secretValue = providerSecrets[secretName];
      if (secretValue) {
        environment[key] = modelProviderEnvironmentSecretValue(
          type,
          secretName,
          secretValue,
        );
      }
    } else {
      environment[key] = value;
    }
  }
  return environment;
}

function vm0ApiKeySelectionOrder() {
  return sql`case when ${vm0ApiKeys.label} = 'dev-seed' then 0 else 1 end`;
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
  const metadata = getModelProviderRefreshMetadata(providerType);
  if (!metadata?.isRefreshable) {
    return undefined;
  }

  const secretConnectorMap: Record<string, string> = {};
  const envBindings = getModelProviderEnvBindings(providerType);
  // Firewall auth templates reference runtime env aliases (for example, the
  // `CHATGPT_ACCESS_TOKEN` in `${{ secrets.CHATGPT_ACCESS_TOKEN }}`), so the
  // refresh map is keyed by envName, not by the backing provider storage key.
  for (const [envName, valueRef] of Object.entries(envBindings ?? {})) {
    if (
      valueRef.startsWith("$secrets.") &&
      metadata.refreshableSecrets.includes(valueRef.slice("$secrets.".length))
    ) {
      secretConnectorMap[envName] = providerType;
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
    readonly featureSwitchContext: FeatureSwitchContext;
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
    storedSecrets[row.name] = await decryptStoredSecretValue(
      row.encryptedValue,
      args.featureSwitchContext,
    );
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
    .orderBy(vm0ApiKeySelectionOrder(), sql`random()`)
    .limit(1);
  const fallbackRows =
    exactRows.length > 0
      ? exactRows
      : await db
          .select({ apiKey: vm0ApiKeys.apiKey })
          .from(vm0ApiKeys)
          .where(eq(vm0ApiKeys.vendor, vendor))
          .orderBy(vm0ApiKeySelectionOrder(), sql`random()`)
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
  readonly featureSwitchContext: FeatureSwitchContext;
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
      featureSwitchContext: args.featureSwitchContext,
    });
  }

  const config = MODEL_PROVIDER_TYPES[row.type];
  if (!isSingleSecretModelProviderConfig(config) || !row.encryptedValue) {
    return null;
  }
  const secretValue = await decryptStoredSecretValue(
    row.encryptedValue,
    args.featureSwitchContext,
  );
  if (!hasUsableModelProviderSecretValue(secretValue)) {
    return null;
  }
  return modelProviderEnvironment(
    row.id,
    row.type,
    config,
    secretValue,
    args.selectedModelOverride ?? row.selectedModel,
  );
}

async function resolveModelProviderEnvironment(
  db: Db,
  args: ResolveModelProviderEnvironmentArgs,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (args.modelProviderType === "vm0") {
    const provider = await vm0ModelProviderEnvironment(
      db,
      args.selectedModelOverride ?? MODEL_PROVIDER_TYPES.vm0.defaultModel,
    );
    return provider?.concreteType &&
      getFrameworkForType(provider.concreteType) === args.framework
      ? provider
      : null;
  }

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

async function loadPersistedRunEnvironmentSnapshot(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly content: AgentComposeContent;
  },
): Promise<PersistedRunEnvironmentSnapshot> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );
    const variableRows = await tx
      .select({
        name: variables.name,
        value: variables.value,
        userId: variables.userId,
      })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, args.orgId),
          eq(variables.type, "user"),
          or(
            eq(variables.userId, ORG_SENTINEL_USER_ID),
            eq(variables.userId, args.userId),
          ),
        ),
      );

    const environment = firstAgent(args.content)?.environment;
    const referencedSecretNames = environment
      ? extractAndGroupVariables(environment).secrets.map((ref) => {
          return ref.name;
        })
      : [];
    const secretNamesToLoad = [...new Set(referencedSecretNames)];
    const secretRows =
      secretNamesToLoad.length > 0
        ? await tx
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
                or(
                  eq(secretsTable.userId, ORG_SENTINEL_USER_ID),
                  eq(secretsTable.userId, args.userId),
                ),
                inArray(secretsTable.name, secretNamesToLoad),
              ),
            )
        : [];

    return { variables: variableRows, secrets: secretRows };
  });
}

function buildMergedVariables(args: {
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
  readonly runVars: Record<string, string> | undefined;
}): Record<string, string> | undefined {
  const orgVars: Record<string, string> = {};
  const userVars: Record<string, string> = {};
  for (const row of args.persistedEnvironment.variables) {
    if (row.userId === ORG_SENTINEL_USER_ID) {
      orgVars[row.name] = row.value;
    } else {
      userVars[row.name] = row.value;
    }
  }

  const merged = { ...orgVars, ...userVars, ...args.runVars };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function buildReferencedSecrets(args: {
  readonly content: AgentComposeContent;
  readonly runSecrets: Record<string, string> | undefined;
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<Record<string, string> | undefined> {
  const environment = firstAgent(args.content)?.environment;
  const referencedNames = environment
    ? extractAndGroupVariables(environment).secrets.map((ref) => {
        return ref.name;
      })
    : [];
  if (referencedNames.length === 0) {
    return args.runSecrets;
  }

  const orgSecrets: Record<string, string> = {};
  const userSecrets: Record<string, string> = {};
  for (const row of args.persistedEnvironment.secrets) {
    const target =
      row.userId === ORG_SENTINEL_USER_ID ? orgSecrets : userSecrets;
    target[row.name] = await decryptStoredSecretValue(
      row.encryptedValue,
      args.featureSwitchContext,
    );
  }

  const merged = { ...orgSecrets, ...userSecrets, ...args.runSecrets };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function compactRecord<T>(
  values: Record<string, T>,
): Record<string, T> | undefined {
  return Object.keys(values).length > 0 ? values : undefined;
}

function mergeRecords<T>(
  ...records: readonly (Record<string, T> | undefined)[]
): Record<string, T> | undefined {
  const merged: Record<string, T> = {};
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

function filterSecretConnectorMetadataMap(args: {
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly secretConnectorMap: Record<string, string> | undefined;
}): Record<string, SecretConnectorMetadata> | undefined {
  if (!args.secretConnectorMetadataMap || !args.secretConnectorMap) {
    return undefined;
  }

  const filtered: Record<string, SecretConnectorMetadata> = {};
  for (const key of Object.keys(args.secretConnectorMap)) {
    const metadata = args.secretConnectorMetadataMap[key];
    if (metadata) {
      filtered[key] = metadata;
    }
  }
  return compactRecord(filtered);
}

interface StoredConnectorRuntimeRow {
  readonly connectorType: ConnectorType;
  readonly authMethod: string;
  readonly needsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
}

interface StoredConnectorRuntimeRowCandidate {
  readonly type: string;
  readonly authMethod: string;
  readonly needsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
}

interface ConnectorEnvBindingSet {
  readonly connectorType: ConnectorType;
  readonly authMethod: string;
  readonly runtimeBindings: readonly ConnectorRuntimeBindingEntry[];
}

interface StoredConnectorRequirements {
  readonly secretNames: Set<string>;
  readonly variableNames: Set<string>;
}

interface StoredConnectorMaterializationPlan {
  readonly allowedConnectorRows: readonly StoredConnectorRuntimeRow[];
  readonly bindingSets: readonly ConnectorEnvBindingSet[];
  readonly requirements: StoredConnectorRequirements;
}

interface StoredConnectorSecretRow {
  readonly name: string;
  readonly encryptedValue: string;
}

interface StoredConnectorVariableRow {
  readonly name: string;
  readonly value: string;
}

interface StoredConnectorMaterializationSnapshot {
  readonly allowedConnectorRows: readonly StoredConnectorRuntimeRow[];
  readonly bindingSets: readonly ConnectorEnvBindingSet[];
  readonly requirements: StoredConnectorRequirements;
  readonly secretRows: readonly StoredConnectorSecretRow[];
  readonly variableRows: readonly StoredConnectorVariableRow[];
  readonly variables: Record<string, string> | undefined;
}

interface ResolvedStoredConnectorState {
  readonly secrets: Record<string, string>;
  readonly vars: Record<string, string>;
  readonly secretConnectorMap: Record<string, string>;
  readonly environment: Record<string, string>;
}

function emptyConnectorRuntimeContext(): ConnectorRuntimeContext {
  return {
    secrets: undefined,
    vars: undefined,
    secretConnectorMap: undefined,
    connectorTypes: [],
    storedEnvironment: undefined,
  };
}

function allowedStoredConnectorRows(
  rows: readonly StoredConnectorRuntimeRowCandidate[],
  allowedConnectorTypes: readonly ConnectorType[] | undefined,
  now: Date,
): readonly StoredConnectorRuntimeRow[] {
  const validRows = rows.flatMap((row) => {
    const parsed = connectorTypeSchema.safeParse(row.type);
    return parsed.success
      ? [
          {
            connectorType: parsed.data,
            authMethod: row.authMethod,
            needsReconnect: row.needsReconnect,
            tokenExpiresAt: row.tokenExpiresAt,
          },
        ]
      : [];
  });
  return validRows.filter((row) => {
    return (
      (!allowedConnectorTypes ||
        allowedConnectorTypes.includes(row.connectorType)) &&
      storedConnectorRuntimeCredentialStatus(row, now) === "available"
    );
  });
}

function storedConnectorRuntimeCredentialStatus(
  row: StoredConnectorRuntimeRow,
  now: Date,
): ConnectorCredentialStatus {
  return connectorRuntimeCredentialStatus({
    type: row.connectorType,
    authMethod: row.authMethod,
    storedNeedsReconnect: row.needsReconnect,
    tokenExpiresAt: row.tokenExpiresAt,
    now,
  });
}

function connectorEnvBindingSets(
  rows: readonly StoredConnectorRuntimeRow[],
): readonly ConnectorEnvBindingSet[] {
  return rows.map((row) => {
    const method = getConnectorAuthMethod(row.connectorType, row.authMethod);
    const metadata = getConnectorAuthMethodRuntimeMetadata(
      row.connectorType,
      row.authMethod,
    );
    if (!method || !metadata) {
      throw new Error(
        `Invalid auth method "${row.authMethod}" for stored connector "${row.connectorType}"`,
      );
    }
    return {
      connectorType: row.connectorType,
      authMethod: row.authMethod,
      runtimeBindings: metadata.runtimeBindings,
    };
  });
}

function collectStoredConnectorRequirements(
  bindingSets: readonly ConnectorEnvBindingSet[],
): StoredConnectorRequirements {
  const secretNames = new Set<string>();
  const variableNames = new Set<string>();

  for (const { runtimeBindings } of bindingSets) {
    for (const { source } of runtimeBindings) {
      switch (source.kind) {
        case "connector-secret": {
          secretNames.add(source.name);
          break;
        }
        case "connector-variable": {
          variableNames.add(source.name);
          break;
        }
        case "platform-secret": {
          break;
        }
      }
    }
  }

  return { secretNames, variableNames };
}

function connectorSecretAliasesByStorageName(
  bindingSets: readonly ConnectorEnvBindingSet[],
): Map<string, Set<string>> {
  const aliases = new Map<string, Set<string>>();
  for (const { runtimeBindings } of bindingSets) {
    for (const { envName, source } of runtimeBindings) {
      if (source.kind !== "connector-secret") {
        continue;
      }
      const existing = aliases.get(source.name);
      if (existing) {
        existing.add(envName);
      } else {
        aliases.set(source.name, new Set([envName]));
      }
    }
  }
  return aliases;
}

function filterOverriddenStoredConnectorSecretRows(args: {
  readonly rows: readonly StoredConnectorSecretRow[];
  readonly bindingSets: readonly ConnectorEnvBindingSet[];
  readonly overriddenSecretAliases: ReadonlySet<string>;
}): readonly StoredConnectorSecretRow[] {
  if (args.overriddenSecretAliases.size === 0) {
    return args.rows;
  }

  const aliasesByStorageName = connectorSecretAliasesByStorageName(
    args.bindingSets,
  );
  return args.rows.filter((row) => {
    const aliases = aliasesByStorageName.get(row.name);
    if (!aliases || aliases.size === 0) {
      return true;
    }
    return [...aliases].some((alias) => {
      return !args.overriddenSecretAliases.has(alias);
    });
  });
}

async function mapWithBoundedConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (values.length === 0) {
    return [];
  }

  const indexedValues = values.map((value, index) => {
    return { index, value };
  });
  const results: ({ readonly value: TOutput } | undefined)[] = Array.from({
    length: values.length,
  });
  const workerCount = Math.min(Math.max(1, concurrency), indexedValues.length);
  let nextIndex = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    while (!stopped) {
      const item = indexedValues[nextIndex];
      nextIndex += 1;
      if (!item) {
        return;
      }

      const value = await onRejection(mapper(item.value, item.index), () => {
        stopped = true;
      });
      results[item.index] = { value };
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      await worker();
    }),
  );

  return indexedValues.map((item) => {
    const result = results[item.index];
    if (!result) {
      throw new Error("Missing bounded concurrency result");
    }
    return result.value;
  });
}

async function loadStoredConnectorSecretRows(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly names: ReadonlySet<string>;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<readonly StoredConnectorSecretRow[]> {
  if (args.names.size === 0) {
    return [];
  }

  const startedAt = now();
  const rows = await onRejection(
    db
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
          inArray(secretsTable.name, [...args.names]),
        ),
      ),
    () => {
      timing?.recordElapsed(
        "api_dispatch_prepare_context_load_stored_connector_secret_rows",
        "nested",
        startedAt,
        now(),
        args.timingDimensions,
      );
    },
  );
  timing?.recordElapsed(
    "api_dispatch_prepare_context_load_stored_connector_secret_rows",
    "nested",
    startedAt,
    now(),
    {
      ...args.timingDimensions,
      stored_connector_secret_count_bucket: countBucket(rows.length),
    },
  );
  return rows;
}

async function decryptStoredConnectorSecrets(
  rows: readonly StoredConnectorSecretRow[],
  args: {
    readonly names: ReadonlySet<string>;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<Record<string, string>> {
  if (rows.length === 0) {
    return {};
  }

  return await measureApiDispatchTiming(
    timing,
    "api_dispatch_prepare_context_decrypt_stored_connector_secrets",
    "nested",
    async () => {
      const decryptedRows = await mapWithBoundedConcurrency(
        rows,
        STORED_CONNECTOR_SECRET_DECRYPT_CONCURRENCY,
        async (row) => {
          return {
            name: row.name,
            value: await decryptStoredSecretValue(
              row.encryptedValue,
              args.featureSwitchContext,
            ),
          };
        },
      );
      const values: Record<string, string> = {};
      for (const row of decryptedRows) {
        values[row.name] = row.value;
      }
      return values;
    },
    {
      ...args.timingDimensions,
      stored_connector_secret_count_bucket: countBucket(rows.length),
    },
  );
}

async function loadStoredConnectorVariableRows(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly names: ReadonlySet<string>;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<readonly StoredConnectorVariableRow[]> {
  if (args.names.size === 0) {
    return [];
  }

  return await measureApiDispatchTiming(
    timing,
    "api_dispatch_prepare_context_load_stored_connector_variable_rows",
    "nested",
    async () => {
      return await db
        .select({
          name: variables.name,
          value: variables.value,
        })
        .from(variables)
        .where(
          and(
            eq(variables.orgId, args.orgId),
            eq(variables.userId, args.userId),
            eq(variables.type, "connector"),
            inArray(variables.name, [...args.names]),
          ),
        );
    },
    args.timingDimensions,
  );
}

function storedConnectorVariablesFromRows(
  rows: readonly StoredConnectorVariableRow[],
): Record<string, string> {
  return Object.fromEntries(
    rows.map((row) => {
      return [row.name, row.value];
    }),
  );
}

function resolveStoredConnectorState(
  bindingSets: readonly ConnectorEnvBindingSet[],
  connectorSecrets: Record<string, string>,
  connectorVariables: Record<string, string>,
  availableSecretNames: ReadonlySet<string>,
): ResolvedStoredConnectorState {
  const secrets: Record<string, string> = {};
  const vars: Record<string, string> = {};
  const secretConnectorMap: Record<string, string> = {};
  const environment: Record<string, string> = {};

  for (const { connectorType, runtimeBindings } of bindingSets) {
    for (const { envName, valueRef, optional, source } of runtimeBindings) {
      switch (source.kind) {
        case "connector-secret": {
          const secretName = source.name;
          const secretValue = connectorSecrets[secretName];
          if (secretValue !== undefined) {
            secrets[envName] = secretValue;
            addConnectorEnvironmentTemplate(environment, envName, valueRef);
          } else if (availableSecretNames.has(secretName)) {
            addConnectorEnvironmentTemplate(environment, envName, valueRef);
          } else if (!optional) {
            addConnectorEnvironmentTemplate(environment, envName, valueRef);
          }
          break;
        }
        case "connector-variable": {
          const variableName = source.name;
          const variableValue = connectorVariables[variableName];
          if (variableValue !== undefined) {
            vars[envName] = variableValue;
            addConnectorEnvironmentTemplate(environment, envName, valueRef);
          } else if (!optional) {
            addConnectorEnvironmentTemplate(environment, envName, valueRef);
          }
          break;
        }
        case "platform-secret": {
          const secretValue = optionalEnv(source.name);
          if (secretValue) {
            secrets[envName] = secretValue;
          }
          break;
        }
      }
    }

    // Firewall auth templates can only reference env aliases from envBindings;
    // store the alias that points at the connector runtime secret, not the
    // backing secret name. Refreshability is resolved later from access metadata.
    for (const { envName, source } of runtimeBindings) {
      if (source.kind === "connector-secret") {
        secretConnectorMap[envName] = connectorType;
      }
    }
  }

  return {
    secrets,
    vars,
    secretConnectorMap,
    environment,
  };
}

function storedConnectorContextFromSnapshot(
  snapshot: StoredConnectorMaterializationSnapshot | null,
): ConnectorRuntimeContext {
  if (!snapshot) {
    return emptyConnectorRuntimeContext();
  }
  return {
    secrets: undefined,
    vars: snapshot.variables,
    secretConnectorMap: undefined,
    connectorTypes: snapshot.allowedConnectorRows.map((row) => {
      return row.connectorType;
    }),
    storedEnvironment: undefined,
  };
}

function availableStoredConnectorSecretNames(
  rows: readonly StoredConnectorSecretRow[],
): ReadonlySet<string> {
  return new Set(
    rows.map((row) => {
      return row.name;
    }),
  );
}

function overriddenRuntimeSecretAliases(
  records: readonly (Record<string, string> | undefined)[],
): ReadonlySet<string> {
  const aliases = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record ?? {})) {
      aliases.add(key);
    }
  }
  return aliases;
}

async function materializeStoredConnectorContext(
  snapshot: StoredConnectorMaterializationSnapshot | null,
  args: {
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly overriddenSecretAliases: ReadonlySet<string>;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<ConnectorRuntimeContext> {
  if (!snapshot) {
    return emptyConnectorRuntimeContext();
  }

  const decryptRows = filterOverriddenStoredConnectorSecretRows({
    rows: snapshot.secretRows,
    bindingSets: snapshot.bindingSets,
    overriddenSecretAliases: args.overriddenSecretAliases,
  });
  const connectorSecrets = await decryptStoredConnectorSecrets(
    decryptRows,
    {
      names: snapshot.requirements.secretNames,
      featureSwitchContext: args.featureSwitchContext,
      timingDimensions: args.timingDimensions,
    },
    timing,
  );
  const availableSecretNames = availableStoredConnectorSecretNames(
    snapshot.secretRows,
  );

  return await measureApiDispatchTiming(
    timing,
    "api_dispatch_prepare_context_build_stored_connector_state",
    "nested",
    () => {
      const resolved = resolveStoredConnectorState(
        snapshot.bindingSets,
        connectorSecrets,
        snapshot.variables ?? {},
        availableSecretNames,
      );

      return Promise.resolve({
        secrets: compactRecord(resolved.secrets),
        vars: compactRecord(resolved.vars),
        secretConnectorMap: compactRecord(resolved.secretConnectorMap),
        connectorTypes: snapshot.allowedConnectorRows.map((row) => {
          return row.connectorType;
        }),
        storedEnvironment: compactRecord(resolved.environment),
      });
    },
    {
      ...args.timingDimensions,
      stored_connector_secret_count_bucket: countBucket(decryptRows.length),
    },
  );
}

async function loadStoredConnectorMaterializationPlan(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedConnectorTypes: readonly ConnectorType[] | undefined;
    readonly scopeSource: ConnectorScopeSource;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<StoredConnectorMaterializationSnapshot | null> {
  if (args.allowedConnectorTypes?.length === 0) {
    return null;
  }

  const allowedConnectorTypes = args.allowedConnectorTypes
    ? [...new Set(args.allowedConnectorTypes)]
    : undefined;

  const snapshot = await loadStoredConnectorMaterializationSnapshot(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      allowedConnectorTypes,
      scopeSource: args.scopeSource,
    },
    timing,
  );
  return snapshot;
}

async function loadStoredConnectorRows(
  tx: DbTransaction,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedConnectorTypes: readonly ConnectorType[] | undefined;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<readonly StoredConnectorRuntimeRowCandidate[]> {
  const startedAt = now();
  const rows = await onRejection(
    (async () => {
      await tx.execute(
        sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
      );
      return await tx
        .select({
          type: connectors.type,
          authMethod: connectors.authMethod,
          needsReconnect: connectors.needsReconnect,
          tokenExpiresAt: connectors.tokenExpiresAt,
        })
        .from(connectors)
        .where(
          and(
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.userId),
            args.allowedConnectorTypes
              ? inArray(connectors.type, args.allowedConnectorTypes)
              : undefined,
          ),
        );
    })(),
    () => {
      timing?.recordElapsed(
        "api_dispatch_prepare_context_load_stored_connector_rows",
        "nested",
        startedAt,
        now(),
        args.timingDimensions,
      );
    },
  );
  timing?.recordElapsed(
    "api_dispatch_prepare_context_load_stored_connector_rows",
    "nested",
    startedAt,
    now(),
    {
      ...args.timingDimensions,
      stored_connector_count_bucket: countBucket(rows.length),
    },
  );
  return rows;
}

function buildStoredConnectorMaterializationPlan(args: {
  readonly connectorRows: readonly StoredConnectorRuntimeRowCandidate[];
  readonly allowedConnectorTypes: readonly ConnectorType[] | undefined;
}): StoredConnectorMaterializationPlan | null {
  const allowedConnectorRows = allowedStoredConnectorRows(
    args.connectorRows,
    args.allowedConnectorTypes,
    nowDate(),
  );
  if (allowedConnectorRows.length === 0) {
    return null;
  }

  const bindingSets = connectorEnvBindingSets(allowedConnectorRows);
  return {
    allowedConnectorRows,
    bindingSets,
    requirements: collectStoredConnectorRequirements(bindingSets),
  };
}

async function filterStoredConnectorRows(
  args: {
    readonly connectorRows: readonly StoredConnectorRuntimeRowCandidate[];
    readonly allowedConnectorTypes: readonly ConnectorType[] | undefined;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<StoredConnectorMaterializationPlan | null> {
  const startedAt = now();
  const result = await settle(
    (async () => {
      await Promise.resolve();
      return buildStoredConnectorMaterializationPlan(args);
    })(),
  );
  if (!result.ok) {
    timing?.recordElapsed(
      "api_dispatch_prepare_context_filter_stored_connector_rows",
      "nested",
      startedAt,
      now(),
      {
        ...args.timingDimensions,
        stored_connector_count_bucket: countBucket(args.connectorRows.length),
      },
    );
    throw result.error;
  }
  const plan = result.value;
  timing?.recordElapsed(
    "api_dispatch_prepare_context_filter_stored_connector_rows",
    "nested",
    startedAt,
    now(),
    {
      ...args.timingDimensions,
      stored_connector_count_bucket: countBucket(
        plan?.allowedConnectorRows.length ?? 0,
      ),
      stored_connector_secret_count_bucket: countBucket(
        plan?.requirements.secretNames.size ?? 0,
      ),
    },
  );
  return plan;
}

async function loadStoredConnectorMaterializationSnapshot(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedConnectorTypes: readonly ConnectorType[] | undefined;
    readonly scopeSource: ConnectorScopeSource;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<StoredConnectorMaterializationSnapshot | null> {
  return await db.transaction(async (tx) => {
    const baseTimingDimensions = storedConnectorTimingDimensions({
      scopeSource: args.scopeSource,
    });
    const connectorRows = await loadStoredConnectorRows(
      tx,
      {
        orgId: args.orgId,
        userId: args.userId,
        allowedConnectorTypes: args.allowedConnectorTypes,
        timingDimensions: baseTimingDimensions,
      },
      timing,
    );
    if (connectorRows.length === 0) {
      return null;
    }

    const storedConnectorPlan = await filterStoredConnectorRows(
      {
        connectorRows,
        allowedConnectorTypes: args.allowedConnectorTypes,
        timingDimensions: baseTimingDimensions,
      },
      timing,
    );
    if (!storedConnectorPlan) {
      return null;
    }
    const connectorTimingDimensions = storedConnectorTimingDimensions({
      scopeSource: args.scopeSource,
      connectorCount: storedConnectorPlan.allowedConnectorRows.length,
    });

    const secretRows = await loadStoredConnectorSecretRows(
      tx,
      {
        orgId: args.orgId,
        userId: args.userId,
        names: storedConnectorPlan.requirements.secretNames,
        timingDimensions: connectorTimingDimensions,
      },
      timing,
    );
    const variableRows = await loadStoredConnectorVariableRows(
      tx,
      {
        orgId: args.orgId,
        userId: args.userId,
        names: storedConnectorPlan.requirements.variableNames,
        timingDimensions: connectorTimingDimensions,
      },
      timing,
    );
    const connectorVariables = storedConnectorVariablesFromRows(variableRows);

    return {
      ...storedConnectorPlan,
      secretRows,
      variableRows,
      variables: compactRecord(connectorVariables),
    } satisfies StoredConnectorMaterializationSnapshot;
  });
}

type CustomConnectorRuntimeDataRows = Awaited<
  ReturnType<typeof loadCustomConnectorRuntimeData>
>;

async function buildCustomConnectorRuntimeContext(args: {
  readonly rows: CustomConnectorRuntimeDataRows;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<CustomConnectorRuntimeContext> {
  const firewalls: ExpandedFirewallConfig[] = [];
  const secrets: Record<string, string> = {};
  for (const row of args.rows) {
    const valueMarkers = new Set(
      row.values.map((value) => {
        return `${value.kind}:${value.key}`;
      }),
    );
    const missingRequired = row.connector.fields.some((field) => {
      return field.required && !valueMarkers.has(`${field.kind}:${field.key}`);
    });
    if (missingRequired) {
      continue;
    }
    const decryptedValues = await decryptCustomConnectorValues({
      values: row.values,
      featureSwitchContext: args.featureSwitchContext,
    });
    const apis: ExpandedFirewallConfig["apis"] = [];
    for (const prefixTemplate of row.connector.prefixTemplates) {
      const renderedPrefix = renderCustomConnectorRuntimePrefix({
        template: prefixTemplate,
        values: decryptedValues,
      });
      if (!renderedPrefix) {
        continue;
      }
      apis.push({
        base: renderedPrefix,
        auth: {
          headers: Object.fromEntries(
            row.connector.headerInjections.map((header) => {
              return [
                header.name,
                renderTemplateForRuntime({
                  template: header.valueTemplate,
                  connectorId: row.connector.id,
                  fields: row.connector.fields,
                }),
              ];
            }),
          ),
          query: Object.fromEntries(
            row.connector.queryInjections.map((query) => {
              return [
                query.name,
                renderTemplateForRuntime({
                  template: query.valueTemplate,
                  connectorId: row.connector.id,
                  fields: row.connector.fields,
                }),
              ];
            }),
          ),
        },
      });
    }
    if (apis.length === 0) {
      continue;
    }
    firewalls.push({
      name: customConnectorInternalName(row.connector.id),
      description: row.connector.displayName,
      apis,
    });
    for (const value of row.values) {
      const field = row.connector.fields.find((candidate) => {
        return candidate.kind === value.kind && candidate.key === value.key;
      });
      if (!field) {
        continue;
      }
      const decryptedValue = decryptedValues[`${value.kind}:${value.key}`];
      if (decryptedValue === undefined) {
        continue;
      }
      secrets[
        customConnectorSecretKey({
          connectorId: row.connector.id,
          kind: value.kind,
          key: value.key,
        })
      ] = decryptedValue;
    }
  }

  return { firewalls, secrets: compactRecord(secrets) };
}

async function loadCustomConnectorContext(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedCustomConnectorIds: readonly string[] | undefined;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<CustomConnectorRuntimeContext> {
  if (args.allowedCustomConnectorIds?.length === 0) {
    return { firewalls: [], secrets: undefined };
  }

  const rows = await loadCustomConnectorRuntimeData(db, {
    orgId: args.orgId,
    userId: args.userId,
    connectorIds: args.allowedCustomConnectorIds,
    measure: async (step, operation) => {
      const actionType =
        step === "connectorRows"
          ? "api_dispatch_prepare_context_load_custom_connector_rows"
          : "api_dispatch_prepare_context_load_custom_connector_value_rows";
      return await measureApiDispatchTiming(
        timing,
        actionType,
        "nested",
        operation,
      );
    },
  });
  if (rows.length === 0) {
    return { firewalls: [], secrets: undefined };
  }

  return await measureApiDispatchTiming(
    timing,
    "api_dispatch_prepare_context_build_custom_connector_firewalls",
    "nested",
    async () => {
      return await buildCustomConnectorRuntimeContext({
        rows,
        featureSwitchContext: args.featureSwitchContext,
      });
    },
  );
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

function allAllowPolicyForPermissions(
  permissionNames: readonly string[],
): FirewallPolicy {
  return {
    policies: Object.fromEntries(
      permissionNames.map((name) => {
        return [name, "allow" as const];
      }),
    ),
    unknownPolicy: "allow",
  };
}

function defaultPolicyForPermissionIndex(
  index: FirewallPermissionIndex,
): FirewallPolicy {
  const policies: Record<string, FirewallPolicy["policies"][string]> = {};
  for (const name of index.permissionNames) {
    policies[name] = index.policyResolver.permission(name);
  }
  return {
    policies,
    unknownPolicy: index.policyResolver.unknown(),
  };
}

async function loadRequiredFirewallPermissionIndex(
  type: string,
): Promise<FirewallPermissionIndex> {
  const index = await loadFirewallPermissionIndex(type);
  if (!index) {
    throw new Error(`Missing firewall permission metadata: ${type}`);
  }
  return index;
}

function getRequiredFirewallExecutionMetadata(
  type: FirewallExecutionMetadataConnectorType,
): FirewallExecutionMetadata {
  const metadata = getFirewallExecutionMetadata(type);
  if (!metadata) {
    throw new Error(`Missing firewall execution metadata: ${type}`);
  }
  return metadata;
}

function networkPolicyForFirewallPolicy(
  permissionNames: readonly string[],
  policy: FirewallPolicy,
): NetworkPolicies[string] {
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

  return {
    allow,
    deny,
    ask,
    unknownPolicy: policy.unknownPolicy ?? "allow",
  };
}

const BASE_URL_VAR_PATTERN = /\$\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const BASE_URL_VALIDATION_SECRET_TEMPLATE = [
  "$",
  "{{ secrets.__VM0_FIREWALL_BASE_URL_VALIDATION }}",
].join("");

function runtimeFirewall(firewall: ExpandedFirewallConfig): Firewall {
  return {
    name: firewall.name,
    apis: firewall.apis.map((api) => {
      return {
        base: api.base,
        ...(api.hostPolicy !== undefined ? { hostPolicy: api.hostPolicy } : {}),
        auth: api.auth,
        permissions: api.permissions ?? [],
      };
    }),
  };
}

function builtinFirewallEntry(
  firewall: ExpandedFirewallConfig,
  vars: Record<string, string> | undefined,
): ExecutionFirewallEntry {
  const names = new Set<string>();
  for (const api of firewall.apis) {
    for (const match of api.base.matchAll(BASE_URL_VAR_PATTERN)) {
      names.add(match[1]!);
    }
  }
  if (names.size === 0) {
    return { kind: "builtin", name: firewall.name };
  }

  const baseUrlVars: Record<string, string> = {};
  for (const name of names) {
    const value = vars?.[name];
    if (!value) {
      throw new FirewallBaseUrlResolutionError(
        `Firewall "${firewall.name}" base URL requires variable "${name}" but it was not provided`,
      );
    }
    baseUrlVars[name] = value;
  }
  resolveFirewallBaseUrlVars([runtimeFirewall(firewall)], vars);
  return { kind: "builtin", name: firewall.name, baseUrlVars };
}

function baseUrlValidationAuth(
  credentialed: boolean,
): Firewall["apis"][number]["auth"] {
  return credentialed
    ? {
        headers: {
          Authorization: `Bearer ${BASE_URL_VALIDATION_SECRET_TEMPLATE}`,
        },
      }
    : {};
}

function builtinFirewallEntryForMetadata(
  metadata: FirewallExecutionMetadata,
  vars: Record<string, string> | undefined,
): ExecutionFirewallEntry {
  if (metadata.baseUrlVarNames.length === 0) {
    return { kind: "builtin", name: metadata.type };
  }

  const baseUrlVars: Record<string, string> = {};
  for (const name of metadata.baseUrlVarNames) {
    const value = vars?.[name];
    if (!value) {
      throw new FirewallBaseUrlResolutionError(
        `Firewall "${metadata.type}" base URL requires variable "${name}" but it was not provided`,
      );
    }
    baseUrlVars[name] = value;
  }
  resolveFirewallBaseUrlVars(
    [
      {
        name: metadata.type,
        apis: metadata.baseUrlTemplates.map((template) => {
          return {
            base: template.base,
            ...(template.hostPolicy !== undefined
              ? { hostPolicy: template.hostPolicy }
              : {}),
            auth: baseUrlValidationAuth(template.credentialed),
            permissions: [],
          };
        }),
      },
    ],
    vars,
  );
  return { kind: "builtin", name: metadata.type, baseUrlVars };
}

function inlineFirewallEntry(
  firewall: ExpandedFirewallConfig,
): ExecutionFirewallEntry {
  return { kind: "inline", firewall: runtimeFirewall(firewall) };
}

function applyConnectorPolicies(
  connectorFirewalls: readonly ExpandedFirewallConfig[],
  policies: FirewallPolicies | undefined,
  entryForFirewall: (
    firewall: ExpandedFirewallConfig,
  ) => ExecutionFirewallEntry,
  defaultPolicyForFirewall: (
    firewall: ExpandedFirewallConfig,
    permissionNames: readonly string[],
  ) => FirewallPolicy,
): Pick<PermissionManifest, "firewalls" | "networkPolicies"> {
  const firewalls: ExecutionFirewalls = [];
  const networkPolicies: NetworkPolicies = {};

  for (const firewall of connectorFirewalls) {
    const policy = policies?.[firewall.name];
    const permissionNames = collectPermissionNames(firewall.apis);
    const defaultPolicy = defaultPolicyForFirewall(firewall, permissionNames);
    firewalls.push(entryForFirewall(firewall));

    if (!policy) {
      networkPolicies[firewall.name] = networkPolicyForFirewallPolicy(
        permissionNames,
        defaultPolicy,
      );
      continue;
    }

    networkPolicies[firewall.name] = networkPolicyForFirewallPolicy(
      permissionNames,
      {
        ...policy,
        unknownPolicy: policy.unknownPolicy ?? defaultPolicy.unknownPolicy,
      },
    );
  }

  return { firewalls, networkPolicies };
}

function modelProviderPermissionManifest(
  modelProvider: ResolvedModelProviderEnvironment | null,
  vars: Record<string, string> | undefined,
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
    firewalls: [builtinFirewallEntry(firewall, vars)],
    environmentSecretPlaceholders: firewallSecretPlaceholdersFromFirewalls([
      firewall,
    ]),
    billableFirewalls: [],
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

interface BuiltinConnectorManifestSource {
  readonly metadata: FirewallExecutionMetadata;
  readonly permissionIndex: FirewallPermissionIndex;
}

function applyBuiltinConnectorMetadataPolicies(
  sources: readonly BuiltinConnectorManifestSource[],
  policies: FirewallPolicies | undefined,
  vars: Record<string, string> | undefined,
): PermissionManifest {
  const firewalls: ExecutionFirewalls = [];
  const networkPolicies: NetworkPolicies = {};
  const environmentSecretPlaceholders: Record<string, string> = {};
  const billableFirewalls: string[] = [];

  for (const source of sources) {
    const name = source.metadata.type;
    const permissionNames = [...source.permissionIndex.permissionNames];
    const defaultPolicy = defaultPolicyForPermissionIndex(
      source.permissionIndex,
    );
    const policy = policies?.[name];
    firewalls.push(builtinFirewallEntryForMetadata(source.metadata, vars));
    Object.assign(
      environmentSecretPlaceholders,
      source.metadata.placeholderValues,
    );
    if (source.metadata.billable) {
      billableFirewalls.push(name);
    }

    if (!policy) {
      networkPolicies[name] = networkPolicyForFirewallPolicy(
        permissionNames,
        defaultPolicy,
      );
      continue;
    }

    networkPolicies[name] = networkPolicyForFirewallPolicy(permissionNames, {
      ...policy,
      unknownPolicy: policy.unknownPolicy ?? defaultPolicy.unknownPolicy,
    });
  }

  return {
    firewalls,
    networkPolicies,
    environmentSecretPlaceholders: compactRecord(environmentSecretPlaceholders),
    billableFirewalls,
  };
}

async function buildPermissionManifest(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly permissionPolicies: FirewallPolicies | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly connectorVars?: Record<string, string>;
  readonly connectorTypes?: readonly ConnectorType[];
  readonly customConnectorFirewalls?: readonly ExpandedFirewallConfig[];
  readonly timing?: ApiDispatchTimingCollector;
}): Promise<PermissionManifest | undefined> {
  const connectorTypes =
    args.connectorTypes ??
    Object.keys(args.permissionPolicies ?? {}).filter(
      isFirewallExecutionMetadataConnectorType,
    );
  const connectorBaseUrlVars = mergeRecords(args.vars, args.connectorVars);
  const builtinConnectorTypes = connectorTypes.filter(
    isFirewallExecutionMetadataConnectorType,
  );

  const builtinSources = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_load_builtin_permission_indexes",
    "nested",
    async () => {
      return await Promise.all(
        builtinConnectorTypes.map(async (type) => {
          const metadata = getRequiredFirewallExecutionMetadata(type);
          const permissionIndex =
            await loadRequiredFirewallPermissionIndex(type);
          return { metadata, permissionIndex };
        }),
      );
    },
  );

  const connectorManifest = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_apply_builtin_permission_policies",
    "nested",
    () => {
      return Promise.resolve(
        applyBuiltinConnectorMetadataPolicies(
          builtinSources,
          args.permissionPolicies,
          connectorBaseUrlVars,
        ),
      );
    },
  );
  const customConnectorManifest = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_apply_custom_permission_policies",
    "nested",
    () => {
      const resolvedCustomConnectorFirewalls = resolveFirewallBaseUrlVars(
        (args.customConnectorFirewalls ?? []).map(runtimeFirewall),
        args.vars,
      );
      return Promise.resolve(
        applyConnectorPolicies(
          resolvedCustomConnectorFirewalls,
          args.permissionPolicies,
          inlineFirewallEntry,
          (_firewall, permissionNames) => {
            return allAllowPolicyForPermissions(permissionNames);
          },
        ),
      );
    },
  );
  const providerManifest = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_apply_model_provider_permission_policy",
    "nested",
    () => {
      return Promise.resolve(
        modelProviderPermissionManifest(args.modelProvider, args.vars),
      );
    },
  );

  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_merge_permission_manifest",
    "nested",
    () => {
      const firewalls = [
        ...(providerManifest?.firewalls ?? []),
        ...connectorManifest.firewalls,
        ...customConnectorManifest.firewalls,
      ];

      if (firewalls.length === 0) {
        return Promise.resolve(undefined);
      }

      return Promise.resolve({
        firewalls,
        environmentSecretPlaceholders: mergeRecords(
          providerManifest?.environmentSecretPlaceholders,
          connectorManifest.environmentSecretPlaceholders,
          firewallSecretPlaceholdersFromFirewalls(
            args.customConnectorFirewalls,
          ),
        ),
        billableFirewalls: [
          ...(providerManifest?.billableFirewalls ?? []),
          ...connectorManifest.billableFirewalls,
        ],
        networkPolicies: {
          ...providerManifest?.networkPolicies,
          ...connectorManifest.networkPolicies,
          ...customConnectorManifest.networkPolicies,
        },
      });
    },
  );
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
  db: RunAdmissionDb,
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
  tx: DbTransaction,
  orgId: string,
): Promise<CreateRunErrorResult | null> {
  const [tier, paidSlots] = await Promise.all([
    orgTier(tx, orgId),
    activePaidConcurrencySlots(tx, orgId),
  ]);
  const limit = getEffectiveConcurrencyLimit(tier, paidSlots);
  if (limit === 0) {
    return null;
  }

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
  args: { readonly orgId: string },
): Promise<CreateRunErrorResult | null> {
  const { rows } = await db.execute<CreditCheckRow>(sql`
    WITH org AS (
      SELECT tier, credits FROM org_metadata
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
      (SELECT tier FROM org) AS tier,
      (SELECT credits FROM org) AS credits,
      (SELECT total FROM expired) AS unsettled_expired
  `);

  const row = rows[0];
  if (!row || row.credits === null) {
    return insufficientCredits();
  }
  if (row.tier === "pro-suspend") {
    return insufficientCredits();
  }

  const credits = Number(row.credits);
  const unsettledExpired = Number(row.unsettled_expired ?? 0);
  return credits - unsettledExpired > 0 ? null : insufficientCredits();
}

async function checkOrgRunTier(
  db: Db,
  args: { readonly orgId: string },
): Promise<CreateRunErrorResult | null> {
  const [row] = await db
    .select({ tier: orgMetadata.tier })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);

  if (!row) {
    return insufficientCredits();
  }
  return row.tier === "pro-suspend" ? insufficientCredits() : null;
}

async function lookupComposeByVersion(
  db: Db,
  versionId: string,
  timing?: ApiDispatchTimingCollector,
): Promise<ResolvedCompose | CreateRunErrorResult> {
  const [row] = await measureApiDispatchTiming(
    timing,
    "api_dispatch_resolve_compose_lookup_version",
    "nested",
    async () => {
      return await db
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
    },
  );

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
  timing?: ApiDispatchTimingCollector,
): Promise<ResolvedCompose | CreateRunErrorResult> {
  const [row] = await measureApiDispatchTiming(
    timing,
    "api_dispatch_resolve_compose_lookup_compose",
    "nested",
    async () => {
      return await db
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
    },
  );

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

function resolveBySessionId(
  db: Db,
  agentSessionId: string,
  userId: string,
  orgId: string,
  timing?: ApiDispatchTimingCollector,
): Computed<Promise<ResolvedCompose | CreateRunErrorResult>> {
  return computed(
    async (get): Promise<ResolvedCompose | CreateRunErrorResult> => {
      const [session] = await measureApiDispatchTiming(
        timing,
        "api_dispatch_resolve_compose_lookup_session",
        "nested",
        async () => {
          return await db
            .select({
              id: agentSessions.id,
              agentComposeId: agentSessions.agentComposeId,
              conversationId: agentSessions.conversationId,
              artifacts: agentSessions.artifacts,
              conversationRunId: conversations.runId,
            })
            .from(agentSessions)
            .leftJoin(
              conversations,
              eq(agentSessions.conversationId, conversations.id),
            )
            .where(
              and(
                eq(agentSessions.id, agentSessionId),
                eq(agentSessions.userId, userId),
                eq(agentSessions.orgId, orgId),
              ),
            )
            .limit(1);
        },
      );

      if (!session) {
        return notFound("Agent session not found");
      }

      const resolved = await resolveByComposeId(
        db,
        session.agentComposeId,
        timing,
      );
      if (isRouteError(resolved)) {
        return resolved;
      }

      const conversationId = session.conversationId;
      const resumeSession =
        conversationId === null
          ? undefined
          : await measureApiDispatchTiming(
              timing,
              "api_dispatch_resolve_compose_load_resume_session",
              "nested",
              async () => {
                return await get(loadResumeSession(db, conversationId, timing));
              },
            );
      const conversationRunId = session.conversationRunId;
      const [lastRun] = conversationRunId
        ? await measureApiDispatchTiming(
            timing,
            "api_dispatch_resolve_compose_lookup_session_vars",
            "nested",
            async () => {
              return await db
                .select({ vars: agentRuns.vars })
                .from(agentRuns)
                .where(eq(agentRuns.id, conversationRunId))
                .limit(1);
            },
          )
        : [];

      return {
        ...resolved,
        artifacts: session.artifacts ?? [],
        vars: (lastRun?.vars as Record<string, string> | null) ?? undefined,
        agentSessionId: session.id,
        continuedFromAgentSessionId: session.id,
        resumeSession,
      };
    },
  );
}

function resolveByCheckpointId(
  db: Db,
  checkpointId: string,
  userId: string,
  orgId: string,
  timing?: ApiDispatchTimingCollector,
): Computed<Promise<ResolvedCompose | CreateRunErrorResult>> {
  return computed(
    async (get): Promise<ResolvedCompose | CreateRunErrorResult> => {
      const [row] = await measureApiDispatchTiming(
        timing,
        "api_dispatch_resolve_compose_lookup_checkpoint",
        "nested",
        async () => {
          return await db
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
        },
      );

      if (!row || row.runUserId !== userId || row.runOrgId !== orgId) {
        return notFound("Checkpoint not found");
      }

      const snapshot = row.snapshot as {
        readonly agentComposeVersionId?: string;
        readonly vars?: Record<string, string>;
      };
      if (!snapshot.agentComposeVersionId) {
        return badRequestMessage(
          "Invalid checkpoint: missing agentComposeVersionId",
        );
      }

      const resolved = await lookupComposeByVersion(
        db,
        snapshot.agentComposeVersionId,
        timing,
      );
      if (isRouteError(resolved)) {
        return resolved;
      }

      return {
        ...resolved,
        artifacts: row.artifacts ?? [],
        vars: snapshot.vars ?? {},
        volumeVersions: parseVolumeVersionsSnapshot(row.volumeVersionsSnapshot),
        additionalVolumes: parseAdditionalVolumesSnapshot(
          row.volumeVersionsSnapshot,
        ),
        resumedFromCheckpointId: checkpointId,
        resumeSession: await measureApiDispatchTiming(
          timing,
          "api_dispatch_resolve_compose_load_resume_session",
          "nested",
          async () => {
            return await get(loadResumeSession(db, row.conversationId, timing));
          },
        ),
      };
    },
  );
}

function loadResumeSession(
  db: Db,
  conversationId: string,
  timing?: ApiDispatchTimingCollector,
): Computed<Promise<StoredExecutionContext["resumeSession"] | undefined>> {
  return computed(
    async (): Promise<StoredExecutionContext["resumeSession"] | undefined> => {
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

      const resumeSession = await measureApiDispatchTiming(
        timing,
        "api_dispatch_resolve_compose_resolve_session_history",
        "nested",
        (): Promise<StoredExecutionContext["resumeSession"] | null> => {
          const cliAgentSessionId = conversation.cliAgentSessionId;
          const hash = conversation.cliAgentSessionHistoryHash;
          if (hash) {
            return Promise.resolve({
              sessionId: cliAgentSessionId,
              historyRef: {
                kind: "blob",
                hash,
              },
            });
          }
          const sessionHistory = conversation.cliAgentSessionHistory;
          if (sessionHistory) {
            return Promise.resolve({
              sessionId: cliAgentSessionId,
              sessionHistory,
            });
          }
          return Promise.resolve(null);
        },
      );

      if (resumeSession === null) {
        return undefined;
      }

      return resumeSession;
    },
  );
}

function resolveCompose(
  db: Db,
  body: CreateRunBody,
  userId: string,
  orgId: string,
  timing?: ApiDispatchTimingCollector,
): Computed<Promise<ResolvedCompose | CreateRunErrorResult>> {
  return computed(
    async (get): Promise<ResolvedCompose | CreateRunErrorResult> => {
      if (body.checkpointId && body.sessionId) {
        return badRequestMessage(
          "Cannot specify both checkpointId and sessionId. Use checkpointId to resume from a checkpoint, or sessionId to continue a session.",
        );
      }

      if (body.checkpointId) {
        const checkpointId = body.checkpointId;
        return await measureApiDispatchTiming(
          timing,
          "api_dispatch_resolve_compose_by_checkpoint_id",
          "nested",
          async () => {
            return await get(
              resolveByCheckpointId(db, checkpointId, userId, orgId, timing),
            );
          },
        );
      }
      if (body.sessionId) {
        const sessionId = body.sessionId;
        return await measureApiDispatchTiming(
          timing,
          "api_dispatch_resolve_compose_by_session_id",
          "nested",
          async () => {
            return await get(
              resolveBySessionId(db, sessionId, userId, orgId, timing),
            );
          },
        );
      }
      if (body.agentComposeVersionId) {
        const agentComposeVersionId = body.agentComposeVersionId;
        return await measureApiDispatchTiming(
          timing,
          "api_dispatch_resolve_compose_by_version_id",
          "nested",
          async () => {
            return await lookupComposeByVersion(
              db,
              agentComposeVersionId,
              timing,
            );
          },
        );
      }
      if (!body.agentComposeId) {
        return badRequestMessage(
          "Missing agentComposeId or agentComposeVersionId. Provide composeId, agentComposeVersionId, checkpointId, or sessionId.",
        );
      }
      const agentComposeId = body.agentComposeId;
      return await measureApiDispatchTiming(
        timing,
        "api_dispatch_resolve_compose_by_compose_id",
        "nested",
        async () => {
          return await resolveByComposeId(db, agentComposeId, timing);
        },
      );
    },
  );
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
  options?: {
    readonly validateEnvironmentReferences?: boolean;
    readonly environmentSecretPlaceholders?: Readonly<Record<string, string>>;
    readonly additionalEnvironment?: Record<string, string>;
    readonly storedConnectorEnvironment?: Record<string, string>;
    readonly connectorVars?: Record<string, string>;
  },
): { readonly framework: SupportedFramework } | CreateRunErrorResult {
  const framework = resolveFramework(content);
  if (!framework) {
    return badRequestMessage(
      "Agent must have a supported framework configured",
    );
  }

  if (options?.validateEnvironmentReferences !== false) {
    const missing = missingEnvironmentReferences({
      content,
      vars,
      secrets,
      environmentSecretPlaceholders: options?.environmentSecretPlaceholders,
      additionalEnvironment: options?.additionalEnvironment,
      storedConnectorEnvironment: options?.storedConnectorEnvironment,
      connectorVars: options?.connectorVars,
    });
    if (missing.length > 0) {
      return badRequestMessage(
        `Missing required values: ${missing.join(", ")}`,
      );
    }
  }

  return { framework };
}

function validateRunFramework(
  content: AgentComposeContent,
  body: CreateRunBody,
): { readonly framework: SupportedFramework } | CreateRunErrorResult {
  return validateCompose(content, body.vars, body.secrets, {
    validateEnvironmentReferences: false,
  });
}

function initialRunBody(args: CreateAgentRunArgs): CreateRunBody {
  return args.includeZeroTokenSecret
    ? withPendingZeroTokenSecret(args.body)
    : args.body;
}

function zeroRunModelProviderValues(
  modelProvider: ResolvedModelProviderEnvironment | null,
): Pick<
  typeof zeroRuns.$inferInsert,
  "modelProvider" | "modelProviderId" | "selectedModel"
> {
  if (!modelProvider) {
    return {
      modelProvider: null,
      modelProviderId: null,
      selectedModel: null,
    };
  }
  return {
    modelProvider: modelProvider.type,
    modelProviderId: modelProvider.id,
    selectedModel: modelProvider.selectedModel,
  };
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
  const metadata: ZeroRunMetadata = args.zeroRunMetadata ?? {};
  await tx.insert(zeroRuns).values({
    id: args.runId,
    triggerSource: args.body.triggerSource ?? "cli",
    automationId: metadata.automationId ?? null,
    triggerId: metadata.triggerId ?? null,
    workflowTriggerId: metadata.workflowTriggerId ?? null,
    runGroupId: metadata.runGroupId ?? null,
    goalId: metadata.goalId ?? null,
    triggerAgentId: metadata.triggerAgentId ?? null,
    ...zeroRunModelProviderValues(args.modelProvider),
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
    readonly featureSwitchContext: FeatureSwitchContext;
  },
): Promise<RunRecord> {
  const agentSessionId =
    args.resolved.agentSessionId ??
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

  if (!agentSessionId) {
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
      continuedFromSessionId: args.resolved.continuedFromAgentSessionId ?? null,
      sessionId: agentSessionId,
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
    const callbackRows = await Promise.all(
      args.callbacks.map(async (callback) => {
        return {
          runId: run.id,
          url: "url" in callback ? callback.url : null,
          internalKind:
            "internalKind" in callback ? callback.internalKind : null,
          encryptedSecret: await encryptPersistentSecretValue(
            callback.secret,
            args.featureSwitchContext,
          ),
          payload: callback.payload,
        };
      }),
    );
    await tx.insert(agentRunCallbacks).values(callbackRows);
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
    readonly featureSwitchContext: FeatureSwitchContext;
  },
): Promise<RunRecord> {
  const agentSessionId =
    args.resolved.agentSessionId ??
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

  if (!agentSessionId) {
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
      continuedFromSessionId: args.resolved.continuedFromAgentSessionId ?? null,
      sessionId: agentSessionId,
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
    const callbackRows = await Promise.all(
      args.callbacks.map(async (callback) => {
        return {
          runId: run.id,
          url: "url" in callback ? callback.url : null,
          internalKind:
            "internalKind" in callback ? callback.internalKind : null,
          encryptedSecret: await encryptPersistentSecretValue(
            callback.secret,
            args.featureSwitchContext,
          ),
          payload: callback.payload,
        };
      }),
    );
    await tx.insert(agentRunCallbacks).values(callbackRows);
  }

  return { ...run, status: "queued" };
}

async function buildStoredExecutionContext(args: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string | undefined;
  readonly resolved: ResolvedCompose;
  readonly body: CreateRunBody;
  readonly framework: SupportedFramework;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
  readonly apiStartTime: number;
  readonly storageManifest: StorageManifest;
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly extraEnvironment: Record<string, string> | undefined;
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<BuiltStoredExecutionContext> {
  const permissions = args.permissionManifest;
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
      storageManifest: args.storageManifest,
      environment: {
        ...expandEnvironment({
          content: args.resolved.content,
          vars: args.body.vars,
          secrets: executionSecrets.secrets,
          additionalEnvironment: args.modelProvider?.environment,
          environmentSecretPlaceholders:
            permissions?.environmentSecretPlaceholders,
          storedConnectorEnvironment: args.connectorContext.storedEnvironment,
          connectorVars: args.connectorContext.vars,
        }),
        ...args.extraEnvironment,
      },
      resumeSession: args.resolved.resumeSession ?? null,
      encryptedSecrets: await encryptPersistentSecretsMap(
        executionSecrets.secrets ?? null,
        args.featureSwitchContext,
      ),
      secretConnectorMap: executionSecrets.secretConnectorMap,
      secretConnectorMetadataMap: executionSecrets.secretConnectorMetadataMap,
      cliAgentType: args.framework,
      debugNoMockClaude: args.body.debugNoMockClaude || undefined,
      debugNoMockCodex: args.body.debugNoMockCodex || undefined,
      captureNetworkBodies: args.body.captureNetworkBodies || undefined,
      apiStartTime: args.apiStartTime,
      userTimezone: args.userTimezone,
      firewalls: permissions?.firewalls,
      networkPolicies: permissions?.networkPolicies,
      disallowedTools: withBuiltinGoalDisabled(
        args.body.disallowedTools,
        isFeatureEnabled(
          FeatureSwitchKey.GoalWorkflows,
          args.featureSwitchContext,
        ),
      ),
      tools: args.body.tools,
      settings: args.body.settings,
      experimentalProfile: runnerProfile(args.resolved.content),
      featureFlags: getAllFeatureStates(args.featureSwitchContext),
      billableFirewalls: [...args.billableFirewalls],
      modelUsageProvider: args.modelUsageProvider,
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

function sanitizedFirewallSnapshot(
  firewall: Firewall,
): Extract<RunContextResponse["firewalls"][number], { apis: unknown }> {
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
}

function firewallSnapshotEntry(
  entry: ExecutionFirewallEntry,
): RunContextResponse["firewalls"][number] {
  if (entry.kind === "inline") {
    return sanitizedFirewallSnapshot(entry.firewall);
  }
  return entry.baseUrlVars
    ? { kind: "builtin", name: entry.name, baseUrlVars: entry.baseUrlVars }
    : { kind: "builtin", name: entry.name };
}

function firewallSnapshots(
  firewalls: ExecutionFirewalls | null | undefined,
): RunContextResponse["firewalls"] {
  if (!firewalls) {
    return [];
  }
  return firewalls.map((entry) => {
    return firewallSnapshotEntry(entry);
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
  const sanitizedEnvironment = sanitizeEnvironment(
    storedContext.environment,
    args.builtContext.secretValues,
  );
  const cliAgentSessionId = storedContext.resumeSession?.sessionId ?? null;
  const snapshot: RunContextAxiomSnapshot = {
    _time: nowDate().toISOString(),
    runId: args.runId,
    userId: args.userId,
    prompt: args.body.prompt,
    appendSystemPrompt: args.body.appendSystemPrompt ?? null,
    sessionId: cliAgentSessionId,
    secretNames: [...args.builtContext.secretNames],
    environmentEntries: environmentRecordToEntries(sanitizedEnvironment),
    firewalls: firewallSnapshots(storedContext.firewalls),
    networkPolicyEntries: networkPoliciesRecordToEntries(
      storedContext.networkPolicies,
    ),
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
    featureFlagEntries: featureFlagsRecordToEntries(storedContext.featureFlags),
  };

  ingestToAxiom(getDatasetName("run-context"), [snapshot]);
}

function buildStoredExecutionSecrets(args: {
  readonly connectorContext: ConnectorRuntimeContext;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly bodySecrets: Record<string, string> | undefined;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
}): StoredExecutionSecrets {
  const filteredConnectorMap = filterSecretConnectorMap({
    secretConnectorMap: args.connectorContext.secretConnectorMap,
    overriddenSecrets: [
      args.modelProvider?.secrets,
      args.bodySecrets,
      args.customConnectorContext.secrets,
    ],
  });
  const filteredModelProviderMap = filterSecretConnectorMap({
    secretConnectorMap: args.modelProvider?.secretConnectorMap,
    overriddenSecrets: [args.bodySecrets, args.customConnectorContext.secrets],
  });
  const filteredModelProviderMetadataMap = filterSecretConnectorMetadataMap({
    secretConnectorMetadataMap: args.modelProvider?.secretConnectorMetadataMap,
    secretConnectorMap: filteredModelProviderMap,
  });
  const secretConnectorMap =
    mergeRecords(filteredConnectorMap, filteredModelProviderMap) ?? null;
  const secrets = mergeRecords(
    args.connectorContext.secrets,
    args.modelProvider?.secrets,
    args.bodySecrets,
    args.customConnectorContext.secrets,
  );
  // The merged map is the runtime `secrets.NAME` namespace consumed by firewall
  // auth and environment expansion. Stored connectors and model providers enter
  // this map under env binding aliases; raw DB storage names stay behind the
  // access metadata used during refresh/lookup.
  return {
    secrets: secrets ?? (secretConnectorMap ? {} : undefined),
    secretConnectorMap,
    secretConnectorMetadataMap: filteredModelProviderMetadataMap ?? null,
  };
}

function billableFirewallsForPermissions(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly permissions: PermissionManifest | undefined;
}): string[] {
  const firewalls = args.permissions?.firewalls ?? [];
  const firewallNames = firewalls.map((firewall) => {
    return firewall.kind === "builtin" ? firewall.name : firewall.firewall.name;
  });
  const modelFirewalls =
    args.modelProvider?.type === "vm0"
      ? firewallNames.filter(isModelProviderFirewallName)
      : [];
  const connectorFirewalls = args.permissions?.billableFirewalls ?? [];

  return [...modelFirewalls, ...connectorFirewalls];
}

function countBucket(
  count: number,
): (typeof STORED_CONNECTOR_COUNT_BUCKET_DIMENSIONS)[number] {
  if (count <= 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 4) {
    return "2_4";
  }
  if (count <= 8) {
    return "5_8";
  }
  if (count <= 16) {
    return "9_16";
  }
  return "17_plus";
}

function storedConnectorTimingDimensions(args: {
  readonly scopeSource: ConnectorScopeSource;
  readonly connectorCount?: number;
  readonly secretCount?: number;
}): ApiDispatchTimingDimensions {
  return {
    connector_scope_source: args.scopeSource,
    ...(args.connectorCount !== undefined
      ? { stored_connector_count_bucket: countBucket(args.connectorCount) }
      : {}),
    ...(args.secretCount !== undefined
      ? { stored_connector_secret_count_bucket: countBucket(args.secretCount) }
      : {}),
  };
}

function isModelProviderFirewallName(name: string): boolean {
  return name.startsWith("model-provider:");
}

function validateModelUsageProviderInvariant(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
}): CreateRunErrorResult | null {
  if (args.modelProvider?.type !== "vm0") {
    return null;
  }
  if (!args.billableFirewalls.some(isModelProviderFirewallName)) {
    return null;
  }
  if (args.modelUsageProvider) {
    return null;
  }
  return providerUnavailable(
    "Built-in model provider did not resolve a supported model for usage reporting",
  );
}

function prepareModelUsageContext(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly permissionManifest: PermissionManifest | undefined;
}): ModelUsageContext | CreateRunErrorResult {
  const billableFirewalls = billableFirewallsForPermissions({
    modelProvider: args.modelProvider,
    permissions: args.permissionManifest,
  });
  const modelUsageProvider = modelUsageProviderForContext(args.modelProvider);
  const validation = validateModelUsageProviderInvariant({
    modelProvider: args.modelProvider,
    billableFirewalls,
    modelUsageProvider,
  });

  return validation ?? { billableFirewalls, modelUsageProvider };
}

function modelUsageProviderForContext(
  modelProvider: ResolvedModelProviderEnvironment | null,
): string | undefined {
  if (!modelProvider?.selectedModel) {
    return undefined;
  }
  const canonicalModel = normalizeRunModelId(modelProvider.selectedModel);
  return isSupportedRunModel(canonicalModel) ? canonicalModel : undefined;
}

async function markRunFailed(
  db: Db,
  runId: string,
  error: unknown,
  dispatchFailedCallbacks: DispatchFailedRunCallbacks | undefined,
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
  if (dispatchFailedCallbacks) {
    await tapError(dispatchFailedCallbacks(db, runId, message), (error) => {
      L.error("Failed to dispatch failed-run callbacks", { runId, error });
    });
  }
  return true;
}

function buildRunnerJobPayload(
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
    readonly permissionManifest: PermissionManifest | undefined;
    readonly billableFirewalls: readonly string[];
    readonly modelUsageProvider: string | undefined;
    readonly apiStartTime: number;
    readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
    readonly includeZeroTokenSecret: boolean | undefined;
    readonly zeroTokenComputerUseHostId: string | undefined;
    readonly chatThreadId: string | undefined;
    readonly extraEnvironment: Record<string, string> | undefined;
    readonly userTimezone: string | undefined;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly timing?: ApiDispatchTimingCollector;
  },
): Computed<Promise<ReturnType<typeof queuedRunnerJobPayload>>> {
  return computed(
    async (get): Promise<ReturnType<typeof queuedRunnerJobPayload>> => {
      const group =
        runnerGroup(args.resolved.content) ??
        optionalEnv("RUNNER_DEFAULT_GROUP");
      if (!group) {
        throw new Error("No executor configured: set RUNNER_DEFAULT_GROUP");
      }
      if (!isOfficialRunnerGroup(group)) {
        throw new Error("Only vm0/* runner groups are supported");
      }

      const profile = runnerProfile(args.resolved.content);
      const featureSwitchOverrides = args.includeZeroTokenSecret
        ? args.featureSwitchContext.overrides
        : undefined;
      const body = args.includeZeroTokenSecret
        ? withZeroTokenSecret(
            args.body,
            generateZeroToken(
              args.userId,
              args.run.id,
              args.orgId,
              featureSwitchOverrides,
              {
                ...(args.zeroTokenComputerUseHostId
                  ? { computerUseHostId: args.zeroTokenComputerUseHostId }
                  : {}),
                ...(args.body.triggerSource
                  ? { triggerSource: args.body.triggerSource }
                  : {}),
              },
            ),
          )
        : args.body;
      const storageManifest = await measureApiDispatchTiming(
        args.timing,
        "api_dispatch_prepare_storage_manifest",
        "nested",
        async () => {
          return await get(
            prepareAgentRunStorageManifest({
              db,
              content: args.resolved.content,
              vars: body.vars,
              agentOrgId: args.resolved.orgId,
              runtimeOrgId: args.orgId,
              userId: args.userId,
              artifacts: args.artifacts,
              volumeVersionOverrides: body.volumeVersions,
              additionalVolumes: args.additionalVolumes,
              framework: args.framework,
              timing: args.timing,
            }),
          );
        },
      );
      const builtContext = await measureApiDispatchTiming(
        args.timing,
        "api_dispatch_build_stored_execution_context",
        "nested",
        async () => {
          return await buildStoredExecutionContext({
            ...args,
            body,
            runId: args.run.id,
            chatThreadId: args.chatThreadId,
            storageManifest,
            userTimezone: args.userTimezone,
            featureSwitchContext: args.featureSwitchContext,
          });
        },
      );
      ingestRunContextSnapshot({
        runId: args.run.id,
        userId: args.userId,
        body,
        builtContext,
      });
      const storedContext = builtContext.context;
      const cliAgentSessionId = storedContext.resumeSession?.sessionId ?? null;
      return queuedRunnerJobPayload({
        runnerGroup: group,
        profile,
        cliAgentSessionId,
        executionContext: storedContext,
      });
    },
  );
}

async function lockRunForDerivedPersistence(
  tx: DbTransaction,
  runId: string,
): Promise<DerivedPersistenceResult | null> {
  const rows = await tx.execute<LockedRunPersistenceRow>(sql`
    SELECT
      ${agentRuns.status} AS "status",
      ${agentRuns.sandboxId} AS "sandboxId"
    FROM ${agentRuns}
    WHERE ${agentRuns.id} = ${runId}
    FOR UPDATE
  `);
  const row = rows.rows[0];
  if (!row) {
    return null;
  }
  const status = runStatusSchema.parse(row.status);
  return row.sandboxId ? { status, sandboxId: row.sandboxId } : { status };
}

function dispatchRun(
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
    readonly permissionManifest: PermissionManifest | undefined;
    readonly billableFirewalls: readonly string[];
    readonly modelUsageProvider: string | undefined;
    readonly apiStartTime: number;
    readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
    readonly includeZeroTokenSecret: boolean | undefined;
    readonly zeroTokenComputerUseHostId: string | undefined;
    readonly chatThreadId: string | undefined;
    readonly extraEnvironment: Record<string, string> | undefined;
    readonly userTimezone: string | undefined;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly timing: ApiDispatchTimingCollector;
  },
): Computed<Promise<DerivedPersistenceResult>> {
  return computed(async (get): Promise<DerivedPersistenceResult> => {
    await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_mark_pending_heartbeat",
      "top_level",
      async () => {
        await db
          .update(agentRuns)
          .set({ lastHeartbeatAt: nowDate() })
          .where(
            and(eq(agentRuns.id, args.run.id), eq(agentRuns.status, "pending")),
          );
      },
    );

    const payload = await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_build_runner_job_payload",
      "top_level",
      async () => {
        return await get(buildRunnerJobPayload(db, args));
      },
    );

    const persisted = await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_persist_runner_job_queue",
      "top_level",
      async () => {
        return await db.transaction(async (tx) => {
          const currentRun = await measureApiDispatchTiming(
            args.timing,
            "api_dispatch_lock_run_for_queue_persistence",
            "nested",
            async () => {
              return await lockRunForDerivedPersistence(tx, args.run.id);
            },
          );
          if (!currentRun) {
            throw new Error("Run disappeared before runner job persistence");
          }
          if (currentRun.status !== "pending") {
            return currentRun;
          }

          await measureApiDispatchTiming(
            args.timing,
            "api_dispatch_insert_runner_job_queue",
            "nested",
            async () => {
              await tx.insert(runnerJobQueue).values({
                runId: args.run.id,
                runnerGroup: payload.runnerGroup,
                profile: payload.profile,
                cliAgentSessionId: payload.cliAgentSessionId,
                executionContext: payload.executionContext,
                expiresAt: new Date(now() + 2 * 60 * 60 * 1000),
              });
            },
          );

          await measureApiDispatchTiming(
            args.timing,
            "api_dispatch_update_run_runner_group",
            "nested",
            async () => {
              await tx
                .update(agentRuns)
                .set({ runnerGroup: payload.runnerGroup })
                .where(
                  and(
                    eq(agentRuns.id, args.run.id),
                    eq(agentRuns.status, "pending"),
                  ),
                );
            },
          );

          return { status: "pending" as const };
        });
      },
    );

    if (persisted.status === "pending") {
      await notifyRunnerJob(db, {
        runnerGroup: payload.runnerGroup,
        runId: args.run.id,
        profile: payload.profile,
        cliAgentSessionId: payload.cliAgentSessionId,
      });
      args.timing.flush({
        runId: args.run.id,
        runnerGroup: payload.runnerGroup,
        profile: payload.profile,
        dispatchPath: "direct",
        ...(args.body.triggerSource
          ? { triggerSource: args.body.triggerSource }
          : {}),
      });
    }

    return persisted;
  });
}

function enqueueRunForConcurrency(
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
    readonly permissionManifest: PermissionManifest | undefined;
    readonly billableFirewalls: readonly string[];
    readonly modelUsageProvider: string | undefined;
    readonly apiStartTime: number;
    readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
    readonly includeZeroTokenSecret: boolean | undefined;
    readonly zeroTokenComputerUseHostId: string | undefined;
    readonly chatThreadId: string | undefined;
    readonly extraEnvironment: Record<string, string> | undefined;
    readonly userTimezone: string | undefined;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
): Computed<Promise<DerivedPersistenceResult>> {
  return computed(async (get): Promise<DerivedPersistenceResult> => {
    const payload = await get(buildRunnerJobPayload(db, args));
    const encryptedParams = await encryptQueuedRunnerJobPayload(
      payload,
      args.featureSwitchContext,
    );

    const persisted = await db.transaction(async (tx) => {
      const currentRun = await lockRunForDerivedPersistence(tx, args.run.id);
      if (!currentRun) {
        throw new Error("Run disappeared before queue persistence");
      }
      if (currentRun.status !== "queued") {
        return currentRun;
      }

      await tx.insert(agentRunQueue).values({
        runId: args.run.id,
        userId: args.userId,
        orgId: args.orgId,
        encryptedParams,
        createdAt: args.run.createdAt,
        expiresAt: new Date(now() + QUEUED_RUN_TTL_MS),
      });
      const [depthRow] = await tx
        .select({ depth: count() })
        .from(agentRunQueue)
        .where(eq(agentRunQueue.orgId, args.orgId));
      recordSandboxOperation({
        sandboxType: "runner",
        actionType: "enqueue_zero_run",
        durationMs: 0,
        success: true,
        runId: args.run.id,
        dimensions: {
          queue_depth: Number(depthRow?.depth ?? 0),
        },
      });
      await tx
        .update(agentRuns)
        .set({ runnerGroup: payload.runnerGroup })
        .where(
          and(eq(agentRuns.id, args.run.id), eq(agentRuns.status, "queued")),
        );

      return { status: "queued" as const };
    });

    if (persisted.status === "queued") {
      await publishOrgSignal(args.orgId, "queue:changed");
    }

    return persisted;
  });
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
  readonly permissionManifest: PermissionManifest | undefined;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
  readonly artifacts: readonly ContextArtifact[];
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
}

async function resolveRunModelProvider(
  db: Db,
  args: CreateAgentRunArgs,
  options: {
    readonly content: AgentComposeContent;
    readonly framework: SupportedFramework;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly signal: AbortSignal;
  },
): Promise<ResolvedModelProviderEnvironment | null | CreateRunErrorResult> {
  const hasFrameworkKey = hasExplicitFrameworkApiKey(
    options.content,
    options.framework,
  );
  const hasProviderOverride =
    args.modelProviderId !== undefined ||
    args.modelProviderCredentialScope !== undefined;
  const shouldResolveModelProvider =
    hasProviderOverride || !hasFrameworkKey || args.modelProviderType === "vm0";
  const modelProvider = shouldResolveModelProvider
    ? await resolveModelProviderEnvironment(db, {
        orgId: args.orgId,
        userId: args.userId,
        framework: options.framework,
        modelProviderId: args.modelProviderId,
        modelProviderCredentialScope: args.modelProviderCredentialScope,
        modelProviderType: args.modelProviderType,
        selectedModelOverride: args.selectedModelOverride,
        featureSwitchContext: options.featureSwitchContext,
      })
    : null;
  options.signal.throwIfAborted();

  if (!shouldResolveModelProvider || modelProvider) {
    return modelProvider;
  }

  if (args.enforceVm0Credits && args.modelProviderType === "vm0") {
    const creditGate = await checkVm0Credits(db, { orgId: args.orgId });
    options.signal.throwIfAborted();
    if (creditGate) {
      return creditGate;
    }
  }

  return providerUnavailable(
    `No model provider configured and ${frameworkApiKeyEnv(options.framework)} is not declared in compose environment`,
  );
}

function loadRunFeatureSwitchContext(
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Computed<Promise<FeatureSwitchContext>> {
  return computed(async (get): Promise<FeatureSwitchContext> => {
    const overrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    return { orgId: args.orgId, userId: args.userId, overrides };
  });
}

async function loadUserTimezone(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<string | undefined> {
  const [row] = await db
    .select({ timezone: orgMembersMetadata.timezone })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, args.orgId),
        eq(orgMembersMetadata.userId, args.userId),
      ),
    )
    .limit(1);

  return row?.timezone ?? undefined;
}

async function loadRunConnectorContexts(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorScope: EffectiveConnectorScope;
  },
  featureSwitchContext: FeatureSwitchContext,
  timing?: ApiDispatchTimingCollector,
): Promise<{
  readonly storedConnectorSnapshot: StoredConnectorMaterializationSnapshot | null;
  readonly storedConnectorMetadataContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
}> {
  const [storedConnectorSnapshot, customConnectorContext] = await Promise.all([
    measureApiDispatchTiming(
      timing,
      "api_dispatch_prepare_context_load_stored_connectors",
      "nested",
      async () => {
        return await loadStoredConnectorMaterializationPlan(
          db,
          {
            orgId: args.orgId,
            userId: args.userId,
            allowedConnectorTypes: args.connectorScope.allowedConnectorTypes,
            scopeSource: args.connectorScope.source,
          },
          timing,
        );
      },
      storedConnectorTimingDimensions({
        scopeSource: args.connectorScope.source,
      }),
    ),
    measureApiDispatchTiming(
      timing,
      "api_dispatch_prepare_context_load_custom_connectors",
      "nested",
      async () => {
        return await loadCustomConnectorContext(
          db,
          {
            orgId: args.orgId,
            userId: args.userId,
            allowedCustomConnectorIds:
              args.connectorScope.allowedCustomConnectorIds,
            featureSwitchContext,
          },
          timing,
        );
      },
    ),
  ]);
  return {
    storedConnectorSnapshot,
    storedConnectorMetadataContext: storedConnectorContextFromSnapshot(
      storedConnectorSnapshot,
    ),
    customConnectorContext,
  };
}

async function buildResolvedRunBody(args: {
  readonly initialBody: CreateRunBody;
  readonly resolved: ResolvedCompose;
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<CreateRunBody> {
  const runVars =
    args.initialBody.vars !== undefined
      ? args.initialBody.vars
      : args.resolved.vars;
  const mergedVars = buildMergedVariables({
    persistedEnvironment: args.persistedEnvironment,
    runVars,
  });
  args.signal.throwIfAborted();

  const body: CreateRunBody = {
    ...args.initialBody,
    vars: mergedVars,
    volumeVersions:
      args.initialBody.volumeVersions !== undefined
        ? args.initialBody.volumeVersions
        : args.resolved.volumeVersions,
  };
  const mergedSecrets = await buildReferencedSecrets({
    content: args.resolved.content,
    runSecrets: body.secrets,
    persistedEnvironment: args.persistedEnvironment,
    featureSwitchContext: args.featureSwitchContext,
  });
  args.signal.throwIfAborted();

  return { ...body, secrets: mergedSecrets };
}

function validateRunEnvironmentReferences(args: {
  readonly resolved: ResolvedCompose;
  readonly body: CreateRunBody;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly validateEnvironmentReferences: boolean | undefined;
}): CreateRunErrorResult | null {
  const validationSecrets = buildStoredExecutionSecrets({
    connectorContext: args.connectorContext,
    modelProvider: args.modelProvider,
    bodySecrets: args.body.secrets,
    customConnectorContext: args.customConnectorContext,
  });
  const validation = validateCompose(
    args.resolved.content,
    args.body.vars,
    validationSecrets.secrets,
    {
      validateEnvironmentReferences: args.validateEnvironmentReferences,
      environmentSecretPlaceholders:
        args.permissionManifest?.environmentSecretPlaceholders,
      additionalEnvironment: args.modelProvider?.environment,
      storedConnectorEnvironment: args.connectorContext.storedEnvironment,
      connectorVars: args.connectorContext.vars,
    },
  );

  return isRouteError(validation) ? validation : null;
}

async function buildPreparedPermissionManifest(args: {
  readonly body: CreateRunBody;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly storedConnectorMetadataContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<PermissionManifest | undefined | CreateRunErrorResult> {
  const result = await settle(
    buildPermissionManifest({
      modelProvider: args.modelProvider,
      permissionPolicies: args.body.permissionPolicies,
      vars: args.body.vars,
      connectorVars: args.storedConnectorMetadataContext.vars,
      connectorTypes: args.storedConnectorMetadataContext.connectorTypes,
      customConnectorFirewalls: args.customConnectorContext.firewalls,
      timing: args.timing,
    }),
  );
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof FirewallBaseUrlResolutionError) {
    return badRequestMessage(result.error.message);
  }
  throw result.error;
}

function preparedRunAdditionalVolumes(args: {
  readonly createArgs: CreateAgentRunArgs;
  readonly connectorScope: EffectiveConnectorScope;
  readonly framework: SupportedFramework;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly body: CreateRunBody;
  readonly resolved: ResolvedCompose;
}): readonly AdditionalVolume[] | undefined {
  return mergeAdditionalVolumes({
    prepend: buildInjectedSkillVolumes(
      {
        injectSkillVolumes: args.createArgs.injectSkillVolumes,
        allowedConnectorTypes: args.connectorScope.allowedConnectorTypes,
      },
      args.framework,
      isFeatureEnabled(
        FeatureSwitchKey.GoalWorkflows,
        args.featureSwitchContext,
      ),
    ),
    base: args.body.additionalVolumes ?? args.resolved.additionalVolumes,
  });
}

type PrepareRunContextGet = <T>(value: Computed<T>) => T;

interface PreparedRunBodyContext {
  readonly body: CreateRunBody;
  readonly resolved: ResolvedCompose;
  readonly connectorScope: EffectiveConnectorScope;
  readonly requestedFramework: SupportedFramework;
  readonly featureSwitchContext: FeatureSwitchContext;
}

interface PreparedRuntimeContext {
  readonly framework: SupportedFramework;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
}

function connectorScopeFromCreateArgs(
  args: CreateAgentRunArgs,
): EffectiveConnectorScope | null {
  if (!args.connectorScope) {
    return null;
  }
  const source =
    args.connectorScope.allowedConnectorTypes.length === 0 &&
    args.connectorScope.allowedCustomConnectorIds.length === 0
      ? "empty"
      : (args.connectorScope.source ?? "explicit");
  return {
    allowedConnectorTypes: args.connectorScope.allowedConnectorTypes,
    allowedCustomConnectorIds: args.connectorScope.allowedCustomConnectorIds,
    source,
  };
}

async function resolveEffectiveConnectorScope(args: {
  readonly db: Db;
  readonly createArgs: CreateAgentRunArgs;
  readonly resolved: ResolvedCompose;
  readonly signal: AbortSignal;
}): Promise<EffectiveConnectorScope | CreateRunErrorResult> {
  const createArgsScope = connectorScopeFromCreateArgs(args.createArgs);
  if (createArgsScope) {
    return createArgsScope;
  }

  const zeroBackedAgent = await loadZeroBackedComposeAgent(args.db, {
    composeId: args.resolved.composeId,
  });
  args.signal.throwIfAborted();
  if (zeroBackedAgent) {
    if (
      zeroBackedAgent.visibility === "private" &&
      zeroBackedAgent.owner !== args.createArgs.userId
    ) {
      return forbidden("Only the private agent owner can run this agent");
    }
    const scope = await loadAgentConnectorScope(args.db, {
      userId: args.createArgs.userId,
      orgId: args.createArgs.orgId,
      agentId: args.resolved.composeId,
    });
    return {
      ...scope,
      source:
        scope.allowedConnectorTypes.length === 0 &&
        scope.allowedCustomConnectorIds.length === 0
          ? "empty"
          : "zero_agent",
    };
  }

  return {
    allowedConnectorTypes: undefined,
    allowedCustomConnectorIds: undefined,
    source: "legacy_all",
  };
}

async function prepareRunBodyContext(args: {
  readonly get: PrepareRunContextGet;
  readonly db: Db;
  readonly createArgs: CreateAgentRunArgs;
  readonly timing: ApiDispatchTimingCollector;
  readonly signal: AbortSignal;
  readonly initialBody: CreateRunBody;
}): Promise<PreparedRunBodyContext | CreateRunErrorResult> {
  const featureSwitchContext = await args.timing.measure(
    "api_dispatch_prepare_context_feature_switches",
    "nested",
    async () => {
      return await args.get(
        loadRunFeatureSwitchContext(args.createArgs, args.signal),
      );
    },
  );
  const resolved = await args.timing.measure(
    "api_dispatch_prepare_context_resolve_compose",
    "nested",
    async () => {
      return await args.get(
        resolveCompose(
          args.db,
          args.initialBody,
          args.createArgs.userId,
          args.createArgs.orgId,
          args.timing,
        ),
      );
    },
  );
  args.signal.throwIfAborted();
  if (isRouteError(resolved)) {
    return resolved;
  }
  if (resolved.orgId !== args.createArgs.orgId) {
    return notFound("Resource not found");
  }

  const connectorScope = await args.timing.measure(
    "api_dispatch_prepare_context_resolve_connector_scope",
    "nested",
    async () => {
      return await resolveEffectiveConnectorScope({
        db: args.db,
        createArgs: args.createArgs,
        resolved,
        signal: args.signal,
      });
    },
  );
  args.signal.throwIfAborted();
  if (isRouteError(connectorScope)) {
    return connectorScope;
  }

  const persistedEnvironment = await args.timing.measure(
    "api_dispatch_prepare_context_load_persisted_environment",
    "nested",
    async () => {
      return await loadPersistedRunEnvironmentSnapshot(args.db, {
        orgId: args.createArgs.orgId,
        userId: args.createArgs.userId,
        content: resolved.content,
      });
    },
  );
  args.signal.throwIfAborted();
  const body = await args.timing.measure(
    "api_dispatch_prepare_context_build_resolved_body",
    "nested",
    async () => {
      return await buildResolvedRunBody({
        initialBody: args.initialBody,
        resolved,
        persistedEnvironment,
        featureSwitchContext,
        signal: args.signal,
      });
    },
  );
  const requestedFrameworkResult = await args.timing.measure(
    "api_dispatch_prepare_context_resolve_framework",
    "nested",
    async () => {
      const frameworkValidation = validateRunFramework(resolved.content, body);
      if (isRouteError(frameworkValidation)) {
        return frameworkValidation;
      }
      return await resolveRequestedRunFramework(
        args.db,
        args.createArgs,
        frameworkValidation.framework,
      );
    },
  );
  args.signal.throwIfAborted();
  if (isRouteError(requestedFrameworkResult)) {
    return requestedFrameworkResult;
  }
  return {
    body,
    resolved,
    connectorScope,
    requestedFramework: requestedFrameworkResult,
    featureSwitchContext,
  };
}

async function prepareRunRuntimeContext(args: {
  readonly db: Db;
  readonly createArgs: CreateAgentRunArgs;
  readonly connectorScope: EffectiveConnectorScope;
  readonly timing: ApiDispatchTimingCollector;
  readonly signal: AbortSignal;
  readonly bodyContext: PreparedRunBodyContext;
}): Promise<PreparedRuntimeContext | CreateRunErrorResult> {
  const { body, resolved, requestedFramework, featureSwitchContext } =
    args.bodyContext;
  const modelProvider = await args.timing.measure(
    "api_dispatch_prepare_context_resolve_model_provider",
    "nested",
    async () => {
      return await resolveRunModelProvider(args.db, args.createArgs, {
        content: resolved.content,
        framework: requestedFramework,
        featureSwitchContext,
        signal: args.signal,
      });
    },
  );
  if (isRouteError(modelProvider)) {
    return modelProvider;
  }
  const framework = modelProvider
    ? modelProviderFramework(modelProvider)
    : requestedFramework;
  const {
    storedConnectorSnapshot,
    storedConnectorMetadataContext,
    customConnectorContext,
  } = await args.timing.measure(
    "api_dispatch_prepare_context_load_connector_contexts",
    "nested",
    async () => {
      return await loadRunConnectorContexts(
        args.db,
        {
          orgId: args.createArgs.orgId,
          userId: args.createArgs.userId,
          connectorScope: args.connectorScope,
        },
        featureSwitchContext,
        args.timing,
      );
    },
    storedConnectorTimingDimensions({
      scopeSource: args.connectorScope.source,
    }),
  );
  args.signal.throwIfAborted();

  const storedConnectorTiming = storedConnectorTimingDimensions({
    scopeSource: args.connectorScope.source,
    connectorCount: storedConnectorSnapshot?.allowedConnectorRows.length ?? 0,
    secretCount: storedConnectorSnapshot?.secretRows.length ?? 0,
  });
  const connectorContextPromise = materializeStoredConnectorContext(
    storedConnectorSnapshot,
    {
      featureSwitchContext,
      overriddenSecretAliases: overriddenRuntimeSecretAliases([
        modelProvider?.secrets,
        body.secrets,
      ]),
      timingDimensions: storedConnectorTiming,
    },
    args.timing,
  );
  const permissionManifestPromise = args.timing.measure(
    "api_dispatch_prepare_context_build_permission_manifest",
    "nested",
    async () => {
      return await buildPreparedPermissionManifest({
        body,
        modelProvider,
        storedConnectorMetadataContext,
        customConnectorContext,
        timing: args.timing,
      });
    },
  );
  const [connectorContext, permissionManifest] = await Promise.all([
    connectorContextPromise,
    permissionManifestPromise,
  ]);
  args.signal.throwIfAborted();
  if (isRouteError(permissionManifest)) {
    return permissionManifest;
  }
  const modelUsageContext = prepareModelUsageContext({
    modelProvider,
    permissionManifest,
  });
  if (isRouteError(modelUsageContext)) {
    return modelUsageContext;
  }

  return {
    framework,
    modelProvider,
    connectorContext,
    customConnectorContext,
    permissionManifest,
    billableFirewalls: modelUsageContext.billableFirewalls,
    modelUsageProvider: modelUsageContext.modelUsageProvider,
  };
}

function prepareRunOutputMetadata(args: {
  readonly createArgs: CreateAgentRunArgs;
  readonly connectorScope: EffectiveConnectorScope;
  readonly framework: SupportedFramework;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly body: CreateRunBody;
  readonly resolved: ResolvedCompose;
}): {
  readonly artifacts: readonly ContextArtifact[];
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
} {
  const additionalVolumes = preparedRunAdditionalVolumes({
    createArgs: args.createArgs,
    connectorScope: args.connectorScope,
    framework: args.framework,
    featureSwitchContext: args.featureSwitchContext,
    body: args.body,
    resolved: args.resolved,
  });
  const artifacts = artifactsForRun({
    resolved: args.resolved,
    framework: args.framework,
    bodyArtifacts: args.body.artifacts,
  }).artifacts;
  return { additionalVolumes, artifacts };
}

function prepareRunContext(
  db: Db,
  args: CreateAgentRunArgs,
  timing: ApiDispatchTimingCollector,
  signal: AbortSignal,
): Computed<Promise<PreparedRunContext | CreateRunErrorResult>> {
  return computed(
    async (get): Promise<PreparedRunContext | CreateRunErrorResult> => {
      const initialBody = initialRunBody(args);
      const captureGate = await enforceCaptureNetworkBodiesGate(
        db,
        args.userId,
        initialBody.captureNetworkBodies,
      );
      signal.throwIfAborted();
      if (captureGate) {
        return captureGate;
      }

      const bodyContext = await prepareRunBodyContext({
        get,
        db,
        createArgs: args,
        timing,
        signal,
        initialBody,
      });
      if (isRouteError(bodyContext)) {
        return bodyContext;
      }

      const runtimeContext = await prepareRunRuntimeContext({
        db,
        createArgs: args,
        connectorScope: bodyContext.connectorScope,
        timing,
        signal,
        bodyContext,
      });
      if (isRouteError(runtimeContext)) {
        return runtimeContext;
      }

      const validation = await timing.measure(
        "api_dispatch_prepare_context_validate_environment",
        "nested",
        async () => {
          return await Promise.resolve(
            validateRunEnvironmentReferences({
              resolved: bodyContext.resolved,
              body: bodyContext.body,
              modelProvider: runtimeContext.modelProvider,
              connectorContext: runtimeContext.connectorContext,
              customConnectorContext: runtimeContext.customConnectorContext,
              permissionManifest: runtimeContext.permissionManifest,
              validateEnvironmentReferences: args.validateEnvironmentReferences,
            }),
          );
        },
      );
      if (validation) {
        return validation;
      }

      const userTimezone = await timing.measure(
        "api_dispatch_prepare_context_load_user_timezone",
        "nested",
        async () => {
          return await loadUserTimezone(db, args);
        },
      );
      signal.throwIfAborted();

      const outputMetadata = await timing.measure(
        "api_dispatch_prepare_context_prepare_output_metadata",
        "nested",
        async () => {
          return await Promise.resolve(
            prepareRunOutputMetadata({
              createArgs: args,
              connectorScope: bodyContext.connectorScope,
              framework: runtimeContext.framework,
              featureSwitchContext: bodyContext.featureSwitchContext,
              body: bodyContext.body,
              resolved: bodyContext.resolved,
            }),
          );
        },
      );

      return {
        body: bodyContext.body,
        resolved: bodyContext.resolved,
        framework: runtimeContext.framework,
        modelProvider: runtimeContext.modelProvider,
        connectorContext: runtimeContext.connectorContext,
        customConnectorContext: runtimeContext.customConnectorContext,
        permissionManifest: runtimeContext.permissionManifest,
        billableFirewalls: runtimeContext.billableFirewalls,
        modelUsageProvider: runtimeContext.modelUsageProvider,
        artifacts: outputMetadata.artifacts,
        additionalVolumes: outputMetadata.additionalVolumes,
        userTimezone,
        featureSwitchContext: bodyContext.featureSwitchContext,
      };
    },
  );
}

async function insertRunWithConcurrency(
  db: Db,
  args: CreateAgentRunArgs,
  context: PreparedRunContext,
  timing: ApiDispatchTimingCollector,
): Promise<RunRecord | CreateRunErrorResult> {
  return await db.transaction(async (tx) => {
    await timing.measure(
      "api_dispatch_admission_lock_wait",
      "nested",
      async () => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${args.orgId}))`,
        );
      },
    );
    const concurrency = await timing.measure(
      "api_dispatch_check_concurrency_limit",
      "nested",
      async () => {
        return await checkRunConcurrencyLimit(tx, args.orgId);
      },
    );
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
          featureSwitchContext: context.featureSwitchContext,
        });
      }
      return concurrency;
    }
    return await timing.measure(
      "api_dispatch_insert_run_record",
      "nested",
      async () => {
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
          featureSwitchContext: context.featureSwitchContext,
        });
      },
    );
  });
}

function completeQueuedRun(input: {
  readonly db: Db;
  readonly args: CreateAgentRunArgs;
  readonly context: PreparedRunContext;
  readonly run: RunRecord;
  readonly signal: AbortSignal;
}): Computed<Promise<Extract<CreateRunRouteResult, { readonly status: 201 }>>> {
  return computed(
    async (
      get,
    ): Promise<Extract<CreateRunRouteResult, { readonly status: 201 }>> => {
      const enqueueResult = await settle(
        get(
          enqueueRunForConcurrency(input.db, {
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
            permissionManifest: input.context.permissionManifest,
            billableFirewalls: input.context.billableFirewalls,
            modelUsageProvider: input.context.modelUsageProvider,
            apiStartTime: input.args.apiStartTime,
            additionalVolumes: input.context.additionalVolumes,
            includeZeroTokenSecret: input.args.includeZeroTokenSecret,
            zeroTokenComputerUseHostId: input.args.zeroTokenComputerUseHostId,
            chatThreadId: input.args.chatThreadId,
            extraEnvironment: input.args.extraEnvironment,
            userTimezone: input.context.userTimezone,
            featureSwitchContext: input.context.featureSwitchContext,
          }),
        ),
      );
      input.signal.throwIfAborted();
      if (!enqueueResult.ok) {
        await markRunFailed(
          input.db,
          input.run.id,
          enqueueResult.error,
          input.args.dispatchFailedCallbacks,
        );
        input.signal.throwIfAborted();
        return failedRunResponse(input.run, enqueueResult.error);
      }
      return createdRunResponse(input.run, enqueueResult.value);
    },
  );
}

function completePendingRun(input: {
  readonly db: Db;
  readonly args: CreateAgentRunArgs;
  readonly context: PreparedRunContext;
  readonly run: RunRecord;
  readonly drainOrgQueue: () => Promise<void>;
  readonly signal: AbortSignal;
  readonly timing: ApiDispatchTimingCollector;
}): Computed<Promise<Extract<CreateRunRouteResult, { readonly status: 201 }>>> {
  return computed(
    async (
      get,
    ): Promise<Extract<CreateRunRouteResult, { readonly status: 201 }>> => {
      const dispatchResult = await settle(
        get(
          dispatchRun(input.db, {
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
            permissionManifest: input.context.permissionManifest,
            billableFirewalls: input.context.billableFirewalls,
            modelUsageProvider: input.context.modelUsageProvider,
            apiStartTime: input.args.apiStartTime,
            additionalVolumes: input.context.additionalVolumes,
            includeZeroTokenSecret: input.args.includeZeroTokenSecret,
            zeroTokenComputerUseHostId: input.args.zeroTokenComputerUseHostId,
            chatThreadId: input.args.chatThreadId,
            extraEnvironment: input.args.extraEnvironment,
            userTimezone: input.context.userTimezone,
            featureSwitchContext: input.context.featureSwitchContext,
            timing: input.timing,
          }),
        ),
      );
      input.signal.throwIfAborted();

      if (dispatchResult.ok) {
        return createdRunResponse(input.run, dispatchResult.value);
      }

      const transitioned = await markRunFailed(
        input.db,
        input.run.id,
        dispatchResult.error,
        input.args.dispatchFailedCallbacks,
      );
      input.signal.throwIfAborted();
      if (transitioned) {
        await tapError(input.drainOrgQueue(), (error) => {
          L.error("Failed to drain org queue after run dispatch failure", {
            runId: input.run.id,
            error,
          });
        });
        input.signal.throwIfAborted();
      }
      return failedRunResponse(input.run, dispatchResult.error);
    },
  );
}

export const createAgentRun$ = command(
  async (
    { get, set },
    args: CreateAgentRunArgs,
    signal: AbortSignal,
  ): Promise<CreateRunRouteResult> => {
    const db = set(writeDb$);
    const timing = args.timing ?? new ApiDispatchTimingCollector();
    timing.recordElapsed(
      "api_dispatch_pre_create_agent_run",
      "top_level",
      args.apiStartTime,
    );
    const tierGate = await timing.measure(
      "api_dispatch_check_org_tier",
      "top_level",
      async () => {
        return await checkOrgRunTier(db, { orgId: args.orgId });
      },
    );
    signal.throwIfAborted();
    if (tierGate) {
      return tierGate;
    }

    const context = await timing.measure(
      "api_dispatch_prepare_run_context",
      "top_level",
      async () => {
        return await get(prepareRunContext(db, args, timing, signal));
      },
    );
    signal.throwIfAborted();
    if (isRouteError(context)) {
      return context;
    }

    const modelTierGate = await checkLimitedFreeRunModelAdmission({
      db,
      orgId: args.orgId,
      selectedModel:
        context.modelProvider?.selectedModel ?? args.selectedModelOverride,
    });
    signal.throwIfAborted();
    if (modelTierGate) {
      return modelTierGate;
    }

    if (args.enforceVm0Credits && context.modelProvider?.type === "vm0") {
      const creditGate = await timing.measure(
        "api_dispatch_check_vm0_credits",
        "top_level",
        async () => {
          return await checkVm0Credits(db, { orgId: args.orgId });
        },
      );
      signal.throwIfAborted();
      if (creditGate) {
        return creditGate;
      }
    }

    const transactionResult = await timing.measure(
      "api_dispatch_insert_run_with_concurrency",
      "top_level",
      async () => {
        return await insertRunWithConcurrency(db, args, context, timing);
      },
    );
    signal.throwIfAborted();

    if (isRouteError(transactionResult)) {
      return transactionResult;
    }

    if (transactionResult.status === "queued") {
      return await get(
        completeQueuedRun({
          db,
          args,
          context,
          run: transactionResult,
          signal,
        }),
      );
    }

    return await get(
      completePendingRun({
        db,
        args,
        context,
        run: transactionResult,
        drainOrgQueue: async () => {
          await set(drainOrgQueue$, { orgId: args.orgId }, signal);
        },
        signal,
        timing,
      }),
    );
  },
);
