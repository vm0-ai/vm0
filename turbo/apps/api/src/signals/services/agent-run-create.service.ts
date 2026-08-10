import { randomUUID } from "node:crypto";
import { command, computed, type Computed } from "ccstate";
import {
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  DEFAULT_PROFILE,
  type PiModelConfig,
  type ConnectorRuntimeTargetRegistration,
  PI_MEMORY_ROOT,
  PI_SKILLS_ROOT,
  type SecretConnectorMetadata,
  type RunSkillSnapshot,
  type StorageMountEntry,
  type StoredConnectorPermissionBaseline,
  type StoredExecutionContext,
} from "@vm0/api-contracts/contracts/runners";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import type { CodexServiceTier } from "@vm0/api-contracts/contracts/chat-threads";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import type { AgentCustomConnectorGrant } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import {
  connectorSlugSchema,
  type ConnectorAuthMethodId,
  type ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import { modelProviderSurfaceProtocolSchema } from "@vm0/api-contracts/contracts/zero-model-provider-gateways";
import {
  getDefaultModel,
  getModelProviderCodexRuntimeConfig,
  getModelProviderEnvBindings,
  getModelImageInputSupport,
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
  type ModelProviderCodexRuntimeConfig,
  type ModelProviderEnvBindings,
  type ModelProviderCredentialScope,
  getModelProviderFirewall,
  type ModelProviderType,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  connectorAuthMethodRuntimeMetadata,
  type ConnectorRuntimeBindingEntry,
} from "@vm0/connectors/connector-auth-method";
import type {
  ConnectorServerFirewallExecutionMetadata,
  ConnectorServerFirewallPermissionIndex,
} from "./connector-server-firewall-catalog.service";
import {
  canonicalizeFirewallBaseUrlVarsForExecution,
  extractSecretNamesFromApis,
  type ExecutionFirewallEntry,
  type ExecutionFirewallInlineEntry,
  type ExecutionFirewalls,
  type ExpandedFirewallConfig,
  FirewallBaseUrlResolutionError,
  type Firewall,
  type FirewallPolicies,
  type FirewallPolicy,
  type NetworkPolicies,
  type NetworkPolicy,
  normalizeFirewallFixedHost,
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
import {
  getAllFeatureStates,
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import { resolveSkillRef, parseGitHubTreeUrl } from "@vm0/core/github-url";
import {
  getCustomConnectorSkillName,
  getCustomConnectorSkillStorageName,
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
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { conversations } from "@vm0/db/schema/conversation";
import { blobs } from "@vm0/db/schema/blob";
import { modelProviders } from "@vm0/db/schema/model-provider";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@vm0/db/schema/model-provider-gateway";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { secrets as secretsTable } from "@vm0/db/schema/secret";
import { userCache } from "@vm0/db/schema/user-cache";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { variables } from "@vm0/db/schema/variable";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRunsBeforeCodexServiceTier } from "@vm0/db/rollout-compat/zero-run-before-codex-service-tier";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import type { PersistedStorageMount } from "@vm0/db/types";
import {
  createPiNoopExecutionEnv,
  formatPiUserPrompt,
  loadPiRunSkills,
  renderPiSystemPrompt,
  type ExecutionEnv,
} from "@vm0/pi-agent-runtime";
import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
  type SQLWrapper,
  type WithSubquery,
} from "drizzle-orm";
import { z } from "zod";
import { env, optionalEnv } from "../../lib/env";
import {
  nullableDriverValueDecoder,
  pgInt8ToBigIntDecoder,
  pgNullDecoder,
  pgTextDecoder,
  zodDriverValueDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import {
  badRequestMessage,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { VERCEL_AUTOMATION_BYPASS_ENV } from "../../lib/preview-automation-bypass";
import { previewAutomationBypass$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import {
  publishOrgSignal,
  publishRunChangedForUserSafely,
} from "../external/realtime";
import { now, nowDate } from "../../lib/time";
import { generateZeroToken } from "../auth/tokens";
import { onRejection, safeSync, settle, tapError } from "../utils";
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
  compileModelProviderGatewayRuntime,
  GATEWAY_RUNTIME_SECRET_NAME,
} from "./model-provider-gateway-runtime";
import {
  CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY,
  CustomConnectorRuntimePrefixError,
  customConnectorInternalName,
  customConnectorPrefixTemplateVariableKeys,
  customConnectorValueMarkerKey,
  decryptCustomConnectorValues,
  loadCustomConnectorRuntimeData,
  renderCustomConnectorRuntimePrefix,
  renderTemplateForRuntime,
} from "./zero-custom-connector.service";
import { refreshCustomConnectorOAuth2ValuesIfNeeded } from "./custom-connector-oauth2.service";
import {
  loadCustomConnectorPermissionBundle,
  type CustomConnectorPermissionBundle,
} from "./custom-connector-permission-bundle.service";
import { effectiveCustomConnectorPermissionBundleRef } from "./feishu-custom-connector-permissions";
import {
  prepareAgentRunStorage,
  type PreparedAgentRunStorage,
  StorageManifestBuildStats,
  type StorageManifestSource,
} from "./agent-run-storage.service";
import { projectLegacyWritebackArtifacts } from "./storage-legacy-projection.service";
import {
  encryptQueuedRunnerJobPayload,
  queuedRunnerJobPayload,
} from "./agent-run-queue-payload.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  isPiEdgeCompatibleProviderType,
  piSandboxModelConfig,
  resolvePiEdgeModelConfig,
  type PiEdgeModelConfig,
  type PiEdgeUsageConfig,
} from "./pi-edge-config";
import { buildRunSkillSnapshot } from "./pi-run-skill-snapshot.service";
import { loadPiLaunchStorageResources } from "./pi-storage-execution-env.service";
import { resolveLiveCodexModelProviderAccessToken } from "./agent-webhook-firewall-auth.service";
import { runnerJobQueueTimestamps } from "./runner-job-queue-lifecycle.service";
import {
  connectorRuntimeCredentialStatusWithMethod,
  type ConnectorCredentialStatus,
} from "./connector-credential-status.service";
import {
  getConnectorRuntimeConnector,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import {
  connectorCredentialSecretReadCondition,
  resolveConnectorCredentialAccess,
  type ConnectorCredentialAccess,
  type ConnectorCredentialReadGroup,
} from "./connector-credential-access.service";
import {
  defaultFirewallPolicyForPermissionIndex,
  networkPolicyForFirewallPolicy,
} from "./firewall-network-policy.service";
import { currentConnectorCatalogValidatorIdentity } from "./connector-catalog-validator-authority";
import { logger } from "../../lib/log";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import type {
  ChatThreadSessionResolution,
  ChatThreadSessionResolutionAction,
} from "./chat-session-continuity.service";
import {
  claimQueueFirstRunAssociation,
  lockGoalQueueFirstRunSource,
  recordQueueFirstClaimedRun,
  recordQueueFirstFailedRun,
  resolveQueueFirstRunAdmission,
  type QueueFirstRunAdmission,
  type QueueFirstRunAssociation,
  type QueueFirstRunClaimResult,
  type QueueFirstRunSessionSnapshotState,
} from "./zero-chat-queued-event.service";
import { recordFirstAssistantEventEligibility } from "./zero-chat-first-assistant-event-metric.service";
import { isWebChatTriggerSource } from "./zero-chat-trigger-source.service";
import {
  cappedBaseConcurrencyLimit,
  loadOrgConcurrencyState,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import {
  checkOrgPlanRunAdmission,
  checkOrgCreditsForRunAdmission,
  checkResolvedOrgCreditsForRunAdmission,
  resolveOrgCreditAvailability,
} from "./zero-run-admission.service";
import { activateUsageAllowanceWindowsForRun } from "./usage-allowance.service";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
  type ApiDispatchTimingActionType,
  type ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";
import {
  loadAgentConnectorScope,
  loadZeroBackedComposeAgent,
} from "./agent-connector-scope.service";
import {
  isCompressedSessionHistoryBlobEncoding,
  normalizeSessionHistoryBlobEncoding,
  type CompressedSessionHistoryBlobEncoding,
} from "./session-history-blobs";
import type { Tx } from "../../lib/db-types";
import {
  activatePendingRun$,
  type PendingRunActivation,
} from "./agent-run-activation.service";

const PENDING_RUN_TTL_MS = 15 * 60 * 1000;
const AUTO_MEMORY_ARTIFACT_NAME = MEMORY_ARTIFACT_NAME;
const PI_LOOP_MODEL = "deepseek-v4-flash" satisfies SupportedRunModel;
type ArtifactMissingRootPolicy = NonNullable<
  StorageMountEntry["missingRootPolicy"]
>;
const AUTO_MEMORY_MISSING_ROOT_POLICY: ArtifactMissingRootPolicy =
  "preserveParentVersion";

function getEffectiveConcurrencyLimit(
  baseLimit: number,
  paidSlots: number,
): number {
  const limit = totalConcurrencyLimit({
    baseLimit: cappedBaseConcurrencyLimit(baseLimit),
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
const EAGER_STORED_CONNECTOR_SECRET_DECRYPT_CONCURRENCY = 4;
const COUNT_BUCKET_DIMENSIONS = [
  "0",
  "1",
  "2_4",
  "5_8",
  "9_16",
  "17_plus",
] as const;

type CreateRunBody = Omit<
  z.infer<typeof unifiedRunRequestSchema>,
  "triggerSource"
> & {
  readonly triggerSource: TriggerSource;
};
type DbTransaction = Tx;

const CODEX_WEB_IMAGE_GENERATION_UPLOAD_PROMPT =
  "If you use the built-in image generation tool and it saves generated output image file(s) to local paths, upload each output file you intend to show with `zero web upload-file -f <path>` before telling the web chat user the image is available. Quote the path when needed. Do not provide only sandbox-local paths, because users cannot open local files.";
const ZERO_IMAGE_RECOGNITION_PROMPT =
  '# Image Recognition Fallback\n\nThis run\'s selected model cannot inspect images directly. To inspect one local PNG, JPEG, or WebP image up to 20 MB, run `zero recognize --file <image-path> --prompt "<instruction>"`.';

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

function withFinalRunAppendSystemPrompt(
  body: CreateRunBody,
  framework: SupportedFramework,
  chatThreadId: string | undefined,
  imageRecognitionAvailable: boolean,
): CreateRunBody {
  const appendedParts: string[] = [];
  if (imageRecognitionAvailable) {
    appendedParts.push(ZERO_IMAGE_RECOGNITION_PROMPT);
  }
  if (
    framework === "codex" &&
    isWebChatTriggerSource(body.triggerSource) &&
    chatThreadId
  ) {
    appendedParts.push(CODEX_WEB_IMAGE_GENERATION_UPLOAD_PROMPT);
  }
  if (appendedParts.length === 0) {
    return body;
  }

  return {
    ...body,
    appendSystemPrompt: [body.appendSystemPrompt, ...appendedParts]
      .filter((part): part is string => {
        return Boolean(part);
      })
      .join("\n\n"),
  };
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

type AdditionalVolumeSources = readonly StorageManifestSource[] | undefined;

interface PreparedAdditionalVolume {
  readonly volume: AdditionalVolume;
  readonly source: StorageManifestSource;
}

interface PreparedAdditionalVolumes {
  readonly volumes: readonly AdditionalVolume[] | undefined;
  readonly sources: AdditionalVolumeSources;
}

interface ZeroRunMetadata {
  // Run provenance for workflow schedule automations.
  readonly workflowAutomationId?: string;
  readonly triggerBrief?: string;
  // Run provenance for autonomous thread-goal continuation.
  readonly goalId?: string;
  readonly autonomyBudget?: number;
  readonly codexServiceTier?: CodexServiceTier;
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
  readonly persistedStorageMounts?: readonly PersistedStorageMount[];
  readonly agentSessionId?: string;
  readonly continuedFromAgentSessionId?: string;
  readonly resumeSession?: StoredExecutionContext["resumeSession"];
}

type ConnectorScopeSource = "explicit" | "zero_agent" | "legacy_all" | "empty";

interface EffectiveConnectorScope {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[] | undefined;
  readonly allowedCustomConnectorIds: readonly string[] | undefined;
  readonly customConnectorGrants:
    | readonly AgentCustomConnectorGrant[]
    | undefined;
  readonly source: ConnectorScopeSource;
}

interface ExplicitConnectorScope {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
  readonly customConnectorGrants?: readonly AgentCustomConnectorGrant[];
  readonly source?: Exclude<ConnectorScopeSource, "legacy_all" | "empty">;
}

// Session naming in this service:
// - agentSessionId is the vm0 application session (`agent_sessions.id`) used
//   for product-level continuation and future correctness checks.
// - cliAgentSessionId is the Claude/Codex CLI agent session stored on
//   `conversations.cli_agent_session_id`.
// Existing API/runner wire fields named `sessionId` are preserved for
// compatibility and normalized to these semantic names at the boundary.

function runnerReuseKey(chatThreadId: string | undefined): string | null {
  return chatThreadId ? `thread:${chatThreadId}` : null;
}

interface RunRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly sessionId: string;
  readonly shouldCreateSession: boolean;
  readonly status: "pending" | "queued";
}

interface LaunchRunIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly shouldCreateSession: boolean;
}

type LaunchRunStatus = "pending" | "queued" | "failed";

type ThreadSessionBindingAction = ChatThreadSessionResolutionAction;

interface ThreadSessionBindingWrite {
  readonly chatThreadId: string;
  readonly agentSessionId: string;
  readonly agentSessionRunId: string;
  readonly action: ThreadSessionBindingAction;
}

type PersistedAtomicLaunchRows =
  | {
      readonly kind: "pending";
      readonly run: RunRecord;
      readonly runnerJobCreatedAt: Date;
      readonly threadSessionBinding: ThreadSessionBindingWrite | undefined;
    }
  | {
      readonly kind: "queued";
      readonly run: RunRecord;
      readonly queueDepth: number;
      readonly telemetryTimestamp: string;
      readonly threadSessionBinding: ThreadSessionBindingWrite | undefined;
    };

type RunnerJobPayload = ReturnType<typeof queuedRunnerJobPayload>;
interface PreparedPiEdgeLaunch {
  readonly model: PiEdgeModelConfig;
  readonly usage?: PiEdgeUsageConfig;
  readonly executionEnv: ExecutionEnv;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly skillSnapshot: RunSkillSnapshot;
}

interface PreparedRunnerLaunch {
  readonly piEdge?: PreparedPiEdgeLaunch;
  readonly runnerJobPayload: RunnerJobPayload;
  readonly runContextSnapshot: RunContextAxiomSnapshot;
  readonly runStorageMounts: readonly PersistedStorageMount[];
  readonly sessionStorageMounts: readonly PersistedStorageMount[];
}

type AgentRunCallbackInsert = typeof agentRunCallbacks.$inferInsert;

type QueueFirstRunClaimed = Extract<
  QueueFirstRunClaimResult,
  { readonly kind: "claimed" }
>;

export interface QueueFirstRunClaimLost {
  readonly kind: "queue-first-claim-lost";
}

interface ThreadSessionSnapshotStale {
  readonly kind: "thread-session-snapshot-stale";
  readonly chatThreadId: string;
  readonly agentSessionId: string;
  readonly agentSessionRunId: string;
  readonly resolutionAction: ChatThreadSessionResolutionAction;
  readonly reason: "binding_changed" | "session_changed";
}

interface ValidatedThreadSessionSnapshot {
  readonly kind: "validated-thread-session-snapshot";
  readonly chatThreadId: string;
  readonly agentSessionId: string | null;
}

type AtomicLaunchCommitResult =
  | {
      readonly kind: "pending";
      readonly run: RunRecord;
      readonly runnerJobPayload: RunnerJobPayload;
      readonly runnerJobCreatedAt: Date;
      readonly runContextSnapshot: RunContextAxiomSnapshot;
      readonly queueFirstClaim: QueueFirstRunClaimed | undefined;
      readonly threadSessionBinding: ThreadSessionBindingWrite | undefined;
    }
  | {
      readonly kind: "queued";
      readonly run: RunRecord;
      readonly runnerJobPayload: RunnerJobPayload;
      readonly queueDepth: number;
      readonly telemetryTimestamp: string;
      readonly runContextSnapshot: RunContextAxiomSnapshot;
      readonly queueFirstClaim: QueueFirstRunClaimed | undefined;
      readonly threadSessionBinding: ThreadSessionBindingWrite | undefined;
    }
  | {
      readonly kind: "queue-payload-required";
    }
  | ThreadSessionSnapshotStale
  | QueueFirstRunClaimLost;
type QueuePayloadRequiredResult = Extract<
  AtomicLaunchCommitResult,
  { readonly kind: "queue-payload-required" }
>;
type AtomicLaunchCommitAttempt =
  | AtomicLaunchCommitResult
  | CreateRunErrorResult;
type CommitAtomicLaunch = (
  encryptedQueuedParams: string | undefined,
) => Promise<AtomicLaunchCommitAttempt>;
type CommittedAtomicLaunchResult = Exclude<
  AtomicLaunchCommitResult,
  | { readonly kind: "queue-payload-required" }
  | QueueFirstRunClaimLost
  | ThreadSessionSnapshotStale
>;

type FailedLaunchCommitResult =
  | {
      readonly kind: "failed";
      readonly createdAt: Date;
      readonly queueFirstClaim: QueueFirstRunClaimed | undefined;
    }
  | QueueFirstRunClaimLost;

export interface ZeroRunModelPin {
  readonly modelProvider: string | null;
  readonly modelProviderId: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

type CreateRunSuccessResult = {
  readonly status: 201;
  readonly body: CreateRunResponse;
  readonly queueFirstClaim?: QueueFirstRunClaimed;
  readonly pendingActivation?: PendingRunActivation;
};

type QueueFirstAgentRunResult =
  | CreateRunSuccessResult
  | CreateRunErrorResult
  | QueueFirstRunClaimLost
  | ThreadSessionSnapshotStale;

export function isQueueFirstRunClaimLost(
  result: unknown,
): result is QueueFirstRunClaimLost {
  return (
    typeof result === "object" &&
    result !== null &&
    "kind" in result &&
    result.kind === "queue-first-claim-lost"
  );
}

export function isThreadSessionSnapshotStale(
  result: unknown,
): result is ThreadSessionSnapshotStale {
  return (
    typeof result === "object" &&
    result !== null &&
    "kind" in result &&
    result.kind === "thread-session-snapshot-stale"
  );
}

interface CommitPreparedLaunchArgs {
  readonly db: Db;
  readonly createArgs: CreateAgentRunArgs;
  readonly context: PreparedRunContext;
  readonly identity: LaunchRunIdentity;
  readonly callbackRows: readonly AgentRunCallbackInsert[];
  readonly launch: PreparedRunnerLaunch;
  readonly encryptedQueuedParams: string | undefined;
  readonly timing: ApiDispatchTimingCollector;
}

interface HttpRunCallback {
  readonly url: string;
  readonly secret: string;
  readonly payload: unknown;
}

interface InternalRunCallback {
  readonly internalKind: InternalRunCallbackKind;
  readonly payload: unknown;
}

type RunCallback = HttpRunCallback | InternalRunCallback;

interface ResolvedModelProviderEnvironment {
  readonly id: string | null;
  readonly type: ModelProviderType;
  readonly concreteType?: ModelProviderType;
  readonly environment: Record<string, string>;
  readonly secrets: Record<string, string>;
  // Server-only credential for the in-API Pi turn. Never persisted into the
  // runner payload; firewall providers keep their sandbox secret placeholders.
  readonly piEdgeApiKey?: string;
  readonly selectedModel: string | null;
  readonly firewall?: ExpandedFirewallConfig;
  readonly inlineFirewall?: boolean;
  readonly secretConnectorMap?: Record<string, string>;
  readonly secretConnectorMetadataMap?: Record<string, SecretConnectorMetadata>;
  readonly codexRuntimeConfig?: ModelProviderCodexRuntimeConfig;
}

interface PermissionManifest {
  readonly firewalls: ExecutionFirewalls;
  readonly networkPolicies: NetworkPolicies;
  readonly connectorPermissionBaseline?: StoredConnectorPermissionBaseline;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly billableFirewalls: readonly string[];
}

interface ModelUsageContext {
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: SupportedRunModel | undefined;
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
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
  readonly runContextStorage: PreparedAgentRunStorage["runContextStorage"];
  readonly secretNames: readonly string[];
  // Plain secret values used for run-context redaction; values, not names.
  readonly secretValues: readonly string[];
}

type BuiltStoredExecutionContextDraft = Omit<
  BuiltStoredExecutionContext,
  "context" | "persistedStorageMounts" | "runContextStorage"
> & {
  readonly context: Omit<StoredExecutionContext, "storageMounts">;
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
  | CreateRunSuccessResult
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
  readonly threadSessionResolution?: ChatThreadSessionResolution;
  readonly includeZeroTokenSecret?: boolean;
  readonly zeroTokenComputerUseHostId?: string;
  readonly zeroTokenCloudBrowserEnabled?: boolean;
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
  readonly queueFirstAssociation?: QueueFirstRunAssociation;
  readonly zeroRunModelPin?: ZeroRunModelPin;
  readonly timing?: ApiDispatchTimingCollector;
  readonly timingDimensions?: ApiDispatchTimingDimensions;
}

function assertThreadBoundRunHasQueueAssociation(
  args: CreateAgentRunArgs,
): void {
  if (args.chatThreadId !== undefined && !args.queueFirstAssociation) {
    throw new Error("Thread-bound run requires a queue-first association");
  }
}

interface ConnectorRuntimeContext {
  readonly secrets: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly connectorSlugs: readonly ConnectorSlug[];
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

const persistedRunEnvironmentRowKindDecoder = zodEnumDriverValueDecoder(
  z.enum(["variable", "secret"]),
);

interface CustomConnectorRuntimeContext {
  readonly firewalls: readonly ExpandedFirewallConfig[];
  readonly reservedSecretAliases: Record<string, true> | undefined;
  readonly permissionPolicies: FirewallPolicies | undefined;
  readonly targets: readonly ConnectorRuntimeTargetRegistration[];
  readonly customConnectorIdByFirewallName: Readonly<Record<string, string>>;
  readonly skills: readonly {
    readonly connectorId: string;
    readonly connectorSlug: string;
  }[];
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
  readonly prepend: readonly PreparedAdditionalVolume[] | undefined;
  readonly base: readonly PreparedAdditionalVolume[] | undefined;
}): PreparedAdditionalVolumes {
  const prepared =
    args.prepend || args.base
      ? [...(args.prepend ?? []), ...(args.base ?? [])]
      : undefined;
  return {
    volumes: prepared?.map((item) => {
      return item.volume;
    }),
    sources: prepared?.map((item) => {
      return item.source;
    }),
  };
}

function prepareAdditionalVolumesWithSource(
  volumes: readonly AdditionalVolume[] | undefined,
  source: StorageManifestSource,
): readonly PreparedAdditionalVolume[] | undefined {
  return volumes?.map((volume) => {
    return { volume, source };
  });
}

function frameworkSkillsMountPath(framework: SupportedFramework): string {
  return framework === "codex"
    ? "/home/user/.codex/skills"
    : "/home/user/.claude/skills";
}

function skillMountPath(skillsRoot: string, skillName: string): string {
  return `${skillsRoot}/${skillName}`;
}

// Legacy CLI runs use the framework resolved from the model provider, never
// the framework declared in the compose. Eligible Pi runs instead receive the
// fixed Pi root before Storage resolves any versions or overlays.
function buildLegacySystemSkillVolumes(
  skillNames: readonly string[],
  skillsRoot: string,
): readonly AdditionalVolume[] {
  return [...new Set(skillNames)].flatMap((skillName) => {
    const url = resolveSkillRef(skillName);
    const parsed = parseGitHubTreeUrl(url);
    if (!parsed) {
      return [];
    }
    return [
      {
        name: getSkillStorageName(parsed.fullPath),
        mountPath: skillMountPath(skillsRoot, parsed.skillName),
        system: true,
      },
    ];
  });
}

function buildConnectorSkillVolumes(
  connectorSlugs: readonly ConnectorSlug[],
  snapshot: ConnectorRuntimeSnapshot,
  skillsRoot: string,
): readonly PreparedAdditionalVolume[] {
  return connectorSlugs.flatMap((connectorSlug) => {
    const connector = getConnectorRuntimeConnector(snapshot, connectorSlug);
    if (connector === undefined) {
      throw new Error("Accepted connector skill metadata is unavailable");
    }
    if (connector.skill.kind === "none") {
      return [];
    }
    const prepared: PreparedAdditionalVolume = {
      volume: {
        name: connector.skill.storageName,
        version: connector.skill.versionId,
        mountPath: skillMountPath(skillsRoot, connectorSlug),
        system: true,
      },
      source: "connector_skill",
    };
    return [prepared];
  });
}

function buildWorkflowSkillVolumes(
  workflows: readonly { readonly name: string; readonly workflowId: string }[],
  skillsRoot: string,
): readonly AdditionalVolume[] {
  return workflows
    .filter((workflow) => {
      return !SEED_SKILLS.includes(workflow.name);
    })
    .map((workflow) => {
      return {
        // The volume is keyed by the workflow id; it mounts at the slug.
        name: getCustomSkillStorageName(workflow.workflowId),
        mountPath: skillMountPath(skillsRoot, workflow.name),
      };
    });
}

function buildCustomConnectorSkillVolumes(
  skills: CustomConnectorRuntimeContext["skills"],
  skillsRoot: string,
): readonly PreparedAdditionalVolume[] {
  return skills.map((skill) => {
    return {
      volume: {
        name: getCustomConnectorSkillStorageName(skill.connectorId),
        mountPath: skillMountPath(
          skillsRoot,
          getCustomConnectorSkillName(skill.connectorSlug, skill.connectorId),
        ),
      },
      source: "custom_connector_skill",
    };
  });
}

function buildInjectedSkillVolumes(
  args: {
    readonly injectSkillVolumes: CreateAgentRunArgs["injectSkillVolumes"];
    readonly allowedConnectorSlugs: readonly ConnectorSlug[] | undefined;
    readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
  },
  skillsRoot: string,
): readonly PreparedAdditionalVolume[] | undefined {
  if (!args.injectSkillVolumes) {
    return undefined;
  }
  const connectorSlugs = args.allowedConnectorSlugs ?? [];
  const seedSkillNames = [...SEED_SKILLS, GOAL_SKILL_NAME];
  // Connector rollout switches govern discovery only. Once a connector slug is
  // part of a run, its accepted catalog skill remains executable and mountable.
  const systemSkillVolumes = [
    ...(prepareAdditionalVolumesWithSource(
      buildLegacySystemSkillVolumes(seedSkillNames, skillsRoot),
      "system_skill",
    ) ?? []),
    ...buildConnectorSkillVolumes(
      connectorSlugs,
      args.connectorCatalogSnapshot,
      skillsRoot,
    ),
  ];
  return [
    ...systemSkillVolumes,
    ...(prepareAdditionalVolumesWithSource(
      buildWorkflowSkillVolumes(args.injectSkillVolumes.workflows, skillsRoot),
      "workflow_skill",
    ) ?? []),
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

function isReturnableRouteError(
  value: AtomicLaunchCommitResult | CreateRunErrorResult,
  signal: AbortSignal,
): value is CreateRunErrorResult {
  if (!isRouteError(value)) {
    return false;
  }
  signal.throwIfAborted();
  return true;
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
  const vm0Model = selectedModel ?? MODEL_PROVIDER_TYPES.vm0.defaultModel;
  if (!vm0Model) {
    return null;
  }
  return getFrameworkForType(getVm0ConcreteProviderType(vm0Model));
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

function autoMemoryMountPath(
  framework: SupportedFramework,
  usePiMemoryPath: boolean,
): string {
  if (usePiMemoryPath) {
    return PI_MEMORY_ROOT;
  }
  return framework === "codex"
    ? CANONICAL_CODEX_MEMORY_MOUNT_PATH
    : CANONICAL_CLAUDE_MEMORY_MOUNT_PATH;
}

function autoMemoryArtifact(
  framework: SupportedFramework,
  usePiMemoryPath: boolean,
): ContextArtifact {
  return withAutoMemoryMissingRootPolicy({
    name: AUTO_MEMORY_ARTIFACT_NAME,
    mountPath: autoMemoryMountPath(framework, usePiMemoryPath),
  });
}

function isCanonicalAutoMemoryArtifact(
  artifact: ContextArtifact,
  framework: SupportedFramework,
  usePiMemoryPath: boolean,
): boolean {
  return (
    artifact.name === AUTO_MEMORY_ARTIFACT_NAME &&
    artifact.mountPath === autoMemoryMountPath(framework, usePiMemoryPath)
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
  usePiMemoryPath: boolean,
): readonly ContextArtifact[] {
  return artifacts.map((artifact) => {
    return isCanonicalAutoMemoryArtifact(artifact, framework, usePiMemoryPath)
      ? withAutoMemoryMissingRootPolicy(artifact)
      : artifact;
  });
}

function claimsAutoMemorySlot(
  artifact: ContextArtifact,
  framework: SupportedFramework,
  usePiMemoryPath: boolean,
): boolean {
  return (
    artifact.name === AUTO_MEMORY_ARTIFACT_NAME ||
    artifact.mountPath === autoMemoryMountPath(framework, usePiMemoryPath)
  );
}

function withoutSupersededAutoMemoryArtifacts(
  artifacts: readonly ContextArtifact[],
  framework: SupportedFramework,
  usePiMemoryPath: boolean,
  slotOwnerIndex: number,
): readonly ContextArtifact[] {
  return artifacts.filter((artifact, index) => {
    return (
      index >= slotOwnerIndex ||
      !isCanonicalAutoMemoryArtifact(artifact, framework, usePiMemoryPath)
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
  readonly usePiMemoryPath: boolean;
  readonly bodyArtifacts: readonly ContextArtifact[] | undefined;
}): RunArtifacts {
  const isContinuation = Boolean(args.resolved.agentSessionId);
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
    if (
      artifact &&
      claimsAutoMemorySlot(artifact, args.framework, args.usePiMemoryPath)
    ) {
      autoMemorySlotArtifactIndex = index;
      break;
    }
  }
  if (autoMemorySlotArtifactIndex === undefined) {
    return {
      artifacts: [
        ...artifacts,
        autoMemoryArtifact(args.framework, args.usePiMemoryPath),
      ],
    };
  }

  const slotOwner = artifacts[autoMemorySlotArtifactIndex]!;
  if (
    !isCanonicalAutoMemoryArtifact(
      slotOwner,
      args.framework,
      args.usePiMemoryPath,
    )
  ) {
    return {
      artifacts: withoutSupersededAutoMemoryArtifacts(
        artifacts,
        args.framework,
        args.usePiMemoryPath,
        autoMemorySlotArtifactIndex,
      ),
    };
  }

  return {
    artifacts: withCanonicalAutoMemoryMissingRootPolicy(
      artifacts,
      args.framework,
      args.usePiMemoryPath,
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

function envBindingsRequireModel(
  envBindings: ModelProviderEnvBindings,
): boolean {
  return Object.values(envBindings).some((value) => {
    return value.includes("$model");
  });
}

function resolveModelProviderModel(args: {
  readonly type: ModelProviderType;
  readonly selectedModel: string | null;
  readonly defaultModel: string | undefined;
  readonly envBindings: ModelProviderEnvBindings | undefined;
}): string | null {
  let model = args.selectedModel;
  if (model === null && args.defaultModel !== undefined) {
    model = args.defaultModel;
  }
  if (
    args.envBindings &&
    envBindingsRequireModel(args.envBindings) &&
    !model &&
    args.defaultModel !== ""
  ) {
    throw new Error(`Missing model for model provider ${args.type}`);
  }
  return model === "" ? null : model;
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

function modelProviderFirewallAuthMaps(
  providerType: ModelProviderType,
  sourceUserId: string,
  secretNames: readonly string[],
):
  | {
      readonly secretConnectorMap: Record<string, string>;
      readonly secretConnectorMetadataMap: Record<
        string,
        SecretConnectorMetadata
      >;
    }
  | undefined {
  if (getModelProviderFirewall(providerType) === undefined) {
    return undefined;
  }

  const uniqueSecretNames = [...new Set(secretNames)];
  if (uniqueSecretNames.length === 0) {
    return undefined;
  }

  const secretConnectorMap = Object.fromEntries(
    uniqueSecretNames.map((secretName) => {
      return [secretName, providerType];
    }),
  );
  const secretConnectorMetadataMap = Object.fromEntries(
    uniqueSecretNames.map((secretName) => {
      return [
        secretName,
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

function modelProviderEnvironment(args: {
  readonly id: string | null;
  readonly type: ModelProviderType;
  readonly config: SingleSecretModelProviderConfig;
  readonly secretValue: string | undefined;
  readonly piEdgeApiKey?: string;
  readonly sourceUserId: string;
  readonly selectedModel: string | null;
}): ResolvedModelProviderEnvironment {
  const firewall = getModelProviderFirewall(args.type);
  const hasFirewallAuth = firewall !== undefined;
  let secrets: Record<string, string> = {};
  if (!hasFirewallAuth) {
    if (args.secretValue === undefined) {
      throw new Error(`Missing eager secret for model provider ${args.type}`);
    }
    secrets = { [args.config.secretName]: args.secretValue };
  }
  const envBindings =
    getModelProviderEnvBindings(args.type) ?? args.config.envBindings;
  const model = resolveModelProviderModel({
    type: args.type,
    selectedModel: args.selectedModel,
    defaultModel: args.config.defaultModel,
    envBindings,
  });
  const runtimeModel = model ? getProviderRuntimeModel(args.type, model) : "";
  const environmentSecret = modelProviderEnvironmentSecretValue(
    args.type,
    args.config.secretName,
    args.secretValue ?? "",
  );
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(envBindings)) {
    environment[key] = value
      .replaceAll("$secret", environmentSecret)
      .replaceAll("$model", runtimeModel);
  }
  const codexRuntimeConfig = getModelProviderCodexRuntimeConfig(args.type);

  return {
    id: args.id,
    type: args.type,
    environment,
    secrets,
    ...(args.piEdgeApiKey ? { piEdgeApiKey: args.piEdgeApiKey } : {}),
    selectedModel: model,
    ...(codexRuntimeConfig ? { codexRuntimeConfig } : {}),
    ...modelProviderFirewallAuthMaps(args.type, args.sourceUserId, [
      args.config.secretName,
    ]),
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

  const model = resolveModelProviderModel({
    type,
    selectedModel,
    defaultModel: getDefaultModel(type),
    envBindings,
  });
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
  const model = resolveModelProviderModel({
    type,
    selectedModel,
    defaultModel: getDefaultModel(type),
    envBindings,
  });
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
    readonly resolvePiEdgeCredentials: boolean;
  },
): Promise<ResolvedModelProviderEnvironment | null> {
  if (!args.authMethod) {
    return null;
  }
  const secretConfig = getSecretsForAuthMethod(args.type, args.authMethod);
  if (!secretConfig) {
    return null;
  }

  const firewall = getModelProviderFirewall(args.type);
  const hasFirewallAuth = firewall !== undefined;
  const secretRows = await db
    .select({
      name: secretsTable.name,
      encryptedValue: hasFirewallAuth
        ? sql`NULL`.mapWith(pgNullDecoder)
        : secretsTable.encryptedValue,
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
  if (hasFirewallAuth) {
    for (const row of secretRows) {
      storedSecrets[row.name] = "__lazy_model_provider_secret__";
    }
  } else {
    for (const row of secretRows) {
      if (row.encryptedValue === null) {
        continue;
      }
      storedSecrets[row.name] = await decryptStoredSecretValue(
        row.encryptedValue,
        args.featureSwitchContext,
      );
    }
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

  const piEdgeApiKey = await resolveMultiAuthPiEdgeApiKey(db, args);

  const selectedModelEnvBindings = getModelProviderEnvBindings(args.type);
  const selectedModel = resolveModelProviderModel({
    type: args.type,
    selectedModel: args.selectedModel,
    defaultModel: getDefaultModel(args.type),
    envBindings: selectedModelEnvBindings,
  });
  const runtimeModel = selectedModel
    ? getProviderRuntimeModel(args.type, selectedModel)
    : null;
  const authMaps = modelProviderFirewallAuthMaps(
    args.type,
    args.userId,
    Object.keys(forwardableSecrets),
  );
  return {
    id: args.id,
    type: args.type,
    environment: providerEnvironmentFromSecretMap(
      args.type,
      forwardableSecrets,
      runtimeModel,
    ),
    secrets: hasFirewallAuth ? {} : forwardableSecrets,
    selectedModel,
    ...(piEdgeApiKey === undefined ? {} : { piEdgeApiKey }),
    secretConnectorMap: authMaps?.secretConnectorMap,
    secretConnectorMetadataMap: authMaps?.secretConnectorMetadataMap,
  };
}

/**
 * Pi edge turns run inside the API with the real credential, but firewall
 * providers above only expose lazy placeholders. Resolve and refresh the Codex
 * access token (a JWT the Pi runtime must be able to parse) when the run is Pi
 * eligible; it is carried only on the API-side edge config, never into the
 * Sandbox environment.
 */
async function resolveMultiAuthPiEdgeApiKey(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: ModelProviderType;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly resolvePiEdgeCredentials: boolean;
  },
): Promise<string | undefined> {
  if (!args.resolvePiEdgeCredentials || args.type !== "codex-oauth-token") {
    return undefined;
  }
  return await resolveLiveCodexModelProviderAccessToken({
    db,
    orgId: args.orgId,
    sourceUserId: args.userId,
    featureSwitchContext: args.featureSwitchContext,
  });
}

async function vm0ModelProviderEnvironment(
  db: Db,
  selectedModel: string,
): Promise<ResolvedModelProviderEnvironment | null> {
  const concreteType = getVm0ConcreteProviderType(selectedModel);
  const vendor = getVm0Vendor(selectedModel);
  const apiModel = getProviderRuntimeModel("vm0", selectedModel);
  const rows = await db
    .select({ apiKey: vm0ApiKeys.apiKey })
    .from(vm0ApiKeys)
    .where(eq(vm0ApiKeys.vendor, vendor))
    .limit(1);
  const apiKey = rows[0]?.apiKey;
  const secretName = getSecretNameForType(concreteType);
  if (!apiKey || !secretName) {
    return null;
  }
  const codexRuntimeConfig = getModelProviderCodexRuntimeConfig(concreteType);

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
    ...(codexRuntimeConfig ? { codexRuntimeConfig } : {}),
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
  readonly resolvePiEdgeCredentials: boolean;
}

async function customGatewayModelProviderEnvironment(
  db: Db,
  args: ResolveModelProviderEnvironmentArgs,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (!args.modelProviderId || !args.selectedModelOverride) {
    return null;
  }
  const [row] = await db
    .select({
      id: modelProviderSurfaces.id,
      protocol: modelProviderSurfaces.protocol,
      apiBaseUrl: modelProviderSurfaces.apiBaseUrl,
      authHeaderName: modelProviderSurfaces.authHeaderName,
      authHeaderTemplate: modelProviderSurfaces.authHeaderTemplate,
      modelMappings: modelProviderSurfaces.modelMappings,
      displayName: modelProviderConnections.displayName,
      encryptedValue: secretsTable.encryptedValue,
    })
    .from(modelProviderSurfaces)
    .innerJoin(
      modelProviderConnections,
      eq(modelProviderSurfaces.connectionId, modelProviderConnections.id),
    )
    .innerJoin(
      secretsTable,
      eq(modelProviderConnections.secretId, secretsTable.id),
    )
    .where(
      and(
        eq(modelProviderSurfaces.id, args.modelProviderId),
        eq(modelProviderConnections.orgId, args.orgId),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }

  const upstreamModel = row.modelMappings[args.selectedModelOverride];
  const protocol = modelProviderSurfaceProtocolSchema.safeParse(row.protocol);
  if (!protocol.success || !upstreamModel) {
    return null;
  }
  const runtime = compileModelProviderGatewayRuntime({
    surfaceId: row.id,
    protocol: protocol.data,
    apiBaseUrl: row.apiBaseUrl,
    displayName: row.displayName,
    authHeaderName: row.authHeaderName,
    authHeaderTemplate: row.authHeaderTemplate,
    upstreamModel,
  });
  if (
    getFrameworkForType(runtime.type) !== args.framework ||
    (args.modelProviderType !== undefined &&
      args.modelProviderType !== runtime.type)
  ) {
    return null;
  }

  const secretValue = await decryptStoredSecretValue(
    row.encryptedValue,
    args.featureSwitchContext,
  );
  if (!hasUsableModelProviderSecretValue(secretValue)) {
    return null;
  }
  return {
    id: row.id,
    type: runtime.type,
    environment: runtime.environment,
    secrets: { [GATEWAY_RUNTIME_SECRET_NAME]: secretValue },
    selectedModel: args.selectedModelOverride,
    firewall: runtime.firewall,
    inlineFirewall: true,
    ...(runtime.codexRuntimeConfig
      ? { codexRuntimeConfig: runtime.codexRuntimeConfig }
      : {}),
  };
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

async function resolveCandidatePiEdgeApiKey(
  args: ResolveModelProviderEnvironmentArgs,
  type: ModelProviderType,
  encryptedValue: string,
  decryptedValue?: string,
): Promise<string | undefined> {
  if (!args.resolvePiEdgeCredentials || !isPiEdgeCompatibleProviderType(type)) {
    return undefined;
  }
  const apiKey =
    decryptedValue ??
    (await decryptStoredSecretValue(encryptedValue, args.featureSwitchContext));
  return hasUsableModelProviderSecretValue(apiKey) ? apiKey : undefined;
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
      resolvePiEdgeCredentials: args.resolvePiEdgeCredentials,
    });
  }

  const config = MODEL_PROVIDER_TYPES[row.type];
  if (!isSingleSecretModelProviderConfig(config) || !row.encryptedValue) {
    return null;
  }
  if (getModelProviderFirewall(row.type) !== undefined) {
    const piEdgeApiKey = await resolveCandidatePiEdgeApiKey(
      args,
      row.type,
      row.encryptedValue,
    );
    return modelProviderEnvironment({
      id: row.id,
      type: row.type,
      config,
      secretValue: undefined,
      ...(piEdgeApiKey ? { piEdgeApiKey } : {}),
      sourceUserId: row.userId,
      selectedModel: args.selectedModelOverride ?? row.selectedModel,
    });
  }
  const secretValue = await decryptStoredSecretValue(
    row.encryptedValue,
    args.featureSwitchContext,
  );
  if (!hasUsableModelProviderSecretValue(secretValue)) {
    return null;
  }
  const piEdgeApiKey = await resolveCandidatePiEdgeApiKey(
    args,
    row.type,
    row.encryptedValue,
    secretValue,
  );
  return modelProviderEnvironment({
    id: row.id,
    type: row.type,
    config,
    secretValue,
    ...(piEdgeApiKey ? { piEdgeApiKey } : {}),
    sourceUserId: row.userId,
    selectedModel: args.selectedModelOverride ?? row.selectedModel,
  });
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

  const customGateway = await customGatewayModelProviderEnvironment(db, args);
  if (customGateway) {
    return customGateway;
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
  const environment = firstAgent(args.content)?.environment;
  const referencedSecretNames = environment
    ? extractAndGroupVariables(environment).secrets.map((ref) => {
        return ref.name;
      })
    : [];
  const secretNamesToLoad = [...new Set(referencedSecretNames)];
  const variableQuery = db
    .select({
      kind: sql`'variable'`
        .mapWith(persistedRunEnvironmentRowKindDecoder)
        .as("kind"),
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
  const rows =
    secretNamesToLoad.length > 0
      ? await variableQuery.unionAll(
          db
            .select({
              kind: sql`'secret'`
                .mapWith(persistedRunEnvironmentRowKindDecoder)
                .as("kind"),
              name: secretsTable.name,
              value: secretsTable.encryptedValue,
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
            ),
        )
      : await variableQuery;

  const variableRows: PersistedRunEnvironmentVariable[] = [];
  const secretRows: PersistedRunEnvironmentSecret[] = [];
  for (const row of rows) {
    if (row.kind === "variable") {
      variableRows.push({
        name: row.name,
        value: row.value,
        userId: row.userId,
      });
    } else {
      secretRows.push({
        name: row.name,
        encryptedValue: row.value,
        userId: row.userId,
      });
    }
  }

  return { variables: variableRows, secrets: secretRows };
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
  readonly overriddenSecrets: readonly (
    | Readonly<Record<string, unknown>>
    | undefined
  )[];
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
  readonly access: ConnectorCredentialAccess;
  readonly connectorSlug: ConnectorSlug;
  readonly connectorStateRevision: bigint;
  readonly authMethod: ConnectorAuthMethodId;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly needsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
}

interface StoredConnectorRuntimeRowCandidate {
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly authMethod: string;
  readonly connectorStateRevision: bigint;
  readonly needsReconnect: boolean;
  readonly orgId: string;
  readonly storageVersion: number;
  readonly tokenExpiresAt: Date | null;
  readonly userId: string;
}

interface StoredConnectorMaterializationSnapshotRow extends StoredConnectorRuntimeRowCandidate {
  readonly secretNames: readonly string[];
  readonly variableValues: Readonly<Record<string, string>>;
}

const storedConnectorSecretNamesDecoder = zodDriverValueDecoder(
  z.array(z.string()),
);
const storedConnectorVariableValuesDecoder = zodDriverValueDecoder(
  z.record(z.string(), z.string()),
);

interface ConnectorEnvBindingSet {
  readonly access: ConnectorCredentialAccess;
  readonly connectorSlug: ConnectorSlug;
  readonly connectorStateRevision: bigint;
  readonly authMethod: ConnectorAuthMethodId;
  readonly runtimeBindings: readonly ConnectorRuntimeBindingEntry[];
}

interface StoredConnectorRequirements {
  readonly secretNames: Set<string>;
  readonly variableNames: Set<string>;
}

interface StoredConnectorMaterializationPlan {
  readonly allowedConnectorRows: readonly StoredConnectorRuntimeRow[];
  readonly bindingSets: readonly ConnectorEnvBindingSet[];
}

interface StoredConnectorSecretRow {
  readonly name: string;
}

interface StoredConnectorEncryptedSecretRow extends StoredConnectorSecretRow {
  readonly encryptedValue: string;
}

interface StoredConnectorMaterializationSnapshot {
  readonly allowedConnectorRows: readonly StoredConnectorRuntimeRow[];
  readonly bindingSets: readonly ConnectorEnvBindingSet[];
  readonly secretRows: readonly StoredConnectorSecretRow[];
  readonly variableValues: Record<string, string>;
}

interface ResolvedStoredConnectorState {
  readonly secrets: Record<string, string>;
  readonly vars: Record<string, string>;
  readonly secretConnectorMap: Record<string, string>;
  readonly secretConnectorMetadataMap: Record<string, SecretConnectorMetadata>;
  readonly environment: Record<string, string>;
}

function emptyConnectorRuntimeContext(): ConnectorRuntimeContext {
  return {
    secrets: undefined,
    vars: undefined,
    secretConnectorMap: undefined,
    secretConnectorMetadataMap: undefined,
    connectorSlugs: [],
    storedEnvironment: undefined,
  };
}

function allowedStoredConnectorRows(
  rows: readonly StoredConnectorRuntimeRowCandidate[],
  allowedConnectorSlugs: readonly ConnectorSlug[] | undefined,
  snapshot: ConnectorRuntimeSnapshot,
  now: Date,
): readonly StoredConnectorRuntimeRow[] {
  const validRows = rows.flatMap((row) => {
    const accessResult = resolveConnectorCredentialAccess({
      snapshot,
      stored: {
        authMethodId: row.authMethod,
        connectorId: row.connectorId,
        connectorSlug: row.connectorSlug,
        orgId: row.orgId,
        storageVersion: row.storageVersion,
        userId: row.userId,
      },
    });
    if (accessResult.kind !== "ok") {
      return [];
    }
    const { access } = accessResult;
    return [
      {
        access,
        connectorSlug: access.runtimeMethod.connectorSlug,
        connectorStateRevision: row.connectorStateRevision,
        authMethod: access.runtimeMethod.authMethodId,
        runtimeMethod: access.runtimeMethod,
        needsReconnect: row.needsReconnect,
        tokenExpiresAt: row.tokenExpiresAt,
      },
    ];
  });
  return validRows.filter((row) => {
    return (
      (!allowedConnectorSlugs ||
        allowedConnectorSlugs.includes(row.connectorSlug)) &&
      storedConnectorRuntimeCredentialStatus(row, now) === "available"
    );
  });
}

function storedConnectorRuntimeCredentialStatus(
  row: StoredConnectorRuntimeRow,
  now: Date,
): ConnectorCredentialStatus {
  return connectorRuntimeCredentialStatusWithMethod({
    method: row.runtimeMethod.method,
    storedNeedsReconnect: row.needsReconnect,
    tokenExpiresAt: row.tokenExpiresAt,
    now,
  });
}

function connectorEnvBindingSets(
  rows: readonly StoredConnectorRuntimeRow[],
): readonly ConnectorEnvBindingSet[] {
  return rows.map((row) => {
    const metadata = connectorAuthMethodRuntimeMetadata(
      row.runtimeMethod.method,
    );
    return {
      access: row.access,
      connectorSlug: row.connectorSlug,
      connectorStateRevision: row.connectorStateRevision,
      authMethod: row.authMethod,
      runtimeBindings: metadata.runtimeBindings,
    };
  });
}

function storedConnectorCredentialNames(args: {
  readonly runtimeBindings: readonly ConnectorRuntimeBindingEntry[];
  readonly kind: "secret" | "variable";
  readonly names?: ReadonlySet<string>;
}): readonly string[] {
  return [
    ...new Set(
      args.runtimeBindings.flatMap(({ source }) => {
        if (
          (args.kind === "secret" && source.kind !== "connector-secret") ||
          (args.kind === "variable" && source.kind !== "connector-variable") ||
          (args.names !== undefined && !args.names.has(source.name))
        ) {
          return [];
        }
        return [source.name];
      }),
    ),
  ];
}

function storedConnectorRequirementsByConnector(
  bindingSets: readonly ConnectorEnvBindingSet[],
): ReadonlyMap<string, StoredConnectorRequirements> {
  return new Map(
    bindingSets.map((bindingSet) => {
      return [
        bindingSet.access.connectorId,
        {
          secretNames: new Set(
            storedConnectorCredentialNames({
              runtimeBindings: bindingSet.runtimeBindings,
              kind: "secret",
            }),
          ),
          variableNames: new Set(
            storedConnectorCredentialNames({
              runtimeBindings: bindingSet.runtimeBindings,
              kind: "variable",
            }),
          ),
        },
      ] as const;
    }),
  );
}

function storedConnectorCredentialReadGroups(args: {
  readonly bindingSets: readonly ConnectorEnvBindingSet[];
  readonly kind: "secret" | "variable";
  readonly names?: ReadonlySet<string>;
}): readonly ConnectorCredentialReadGroup[] {
  return args.bindingSets.flatMap((bindingSet) => {
    const names = storedConnectorCredentialNames({
      runtimeBindings: bindingSet.runtimeBindings,
      kind: args.kind,
      ...(args.names === undefined ? {} : { names: args.names }),
    });
    return names.length === 0
      ? []
      : [
          {
            access: bindingSet.access,
            connectorStateRevision: bindingSet.connectorStateRevision,
            names,
          },
        ];
  });
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

async function loadStoredConnectorEncryptedSecretRows(
  db: Db,
  args: {
    readonly bindingSets: readonly ConnectorEnvBindingSet[];
    readonly names: ReadonlySet<string>;
  },
): Promise<readonly StoredConnectorEncryptedSecretRow[]> {
  if (args.names.size === 0) {
    return [];
  }

  const groups = storedConnectorCredentialReadGroups({
    bindingSets: args.bindingSets,
    kind: "secret",
    names: args.names,
  });
  return await db
    .select({
      name: secretsTable.name,
      encryptedValue: secretsTable.encryptedValue,
    })
    .from(secretsTable)
    .where(
      connectorCredentialSecretReadCondition({
        db,
        groups,
      }),
    );
}

async function decryptStoredConnectorSecretRows(
  rows: readonly StoredConnectorEncryptedSecretRow[],
  args: {
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
        EAGER_STORED_CONNECTOR_SECRET_DECRYPT_CONCURRENCY,
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
      return Object.fromEntries(
        decryptedRows.map((row) => {
          return [row.name, row.value];
        }),
      );
    },
    {
      ...args.timingDimensions,
      stored_connector_secret_count_bucket: countBucket(rows.length),
    },
  );
}

function storedConnectorRuntimeVariables(
  bindingSets: readonly ConnectorEnvBindingSet[],
  connectorVariables: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const { runtimeBindings } of bindingSets) {
    for (const { envName, source } of runtimeBindings) {
      if (source.kind !== "connector-variable") {
        continue;
      }
      const value = connectorVariables[source.name];
      if (value !== undefined) {
        vars[envName] = value;
      }
    }
  }
  return vars;
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
  const secretConnectorMetadataMap: Record<string, SecretConnectorMetadata> =
    {};
  const environment: Record<string, string> = {};

  for (const { connectorSlug, runtimeBindings } of bindingSets) {
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
          break;
        }
      }
    }

    // Firewall auth templates can only reference env aliases from envBindings;
    // store the alias that points at the connector runtime secret, not the
    // backing secret name. Refreshability is resolved later from access metadata.
    for (const { envName, source } of runtimeBindings) {
      if (source.kind === "connector-secret") {
        secretConnectorMap[envName] = connectorSlug;
      } else if (source.kind === "platform-secret") {
        secretConnectorMap[envName] = connectorSlug;
        secretConnectorMetadataMap[envName] = { sourceType: "platform-secret" };
      }
    }
  }

  return {
    secrets,
    vars,
    secretConnectorMap,
    secretConnectorMetadataMap,
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
    vars: compactRecord(
      storedConnectorRuntimeVariables(
        snapshot.bindingSets,
        snapshot.variableValues,
      ),
    ),
    secretConnectorMap: undefined,
    secretConnectorMetadataMap: undefined,
    connectorSlugs: snapshot.allowedConnectorRows.map((row) => {
      return row.connectorSlug;
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

function referencedEnvironmentSecretAliases(
  environment: Record<string, string> | undefined,
): ReadonlySet<string> {
  if (!environment) {
    return new Set();
  }
  return new Set(
    extractAndGroupVariables(environment).secrets.map((ref) => {
      return ref.name;
    }),
  );
}

async function materializeStoredConnectorContext(
  snapshot: StoredConnectorMaterializationSnapshot | null,
  args: {
    readonly overriddenSecretAliases: ReadonlySet<string>;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<ConnectorRuntimeContext> {
  if (!snapshot) {
    return emptyConnectorRuntimeContext();
  }

  const availableSecretRows = filterOverriddenStoredConnectorSecretRows({
    rows: snapshot.secretRows,
    bindingSets: snapshot.bindingSets,
    overriddenSecretAliases: args.overriddenSecretAliases,
  });
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
        {},
        snapshot.variableValues,
        availableSecretNames,
      );

      return Promise.resolve({
        secrets: compactRecord(resolved.secrets),
        vars: compactRecord(resolved.vars),
        secretConnectorMap: compactRecord(resolved.secretConnectorMap),
        secretConnectorMetadataMap: compactRecord(
          resolved.secretConnectorMetadataMap,
        ),
        connectorSlugs: snapshot.allowedConnectorRows.map((row) => {
          return row.connectorSlug;
        }),
        storedEnvironment: compactRecord(resolved.environment),
      });
    },
    {
      ...args.timingDimensions,
      stored_connector_secret_count_bucket: countBucket(
        availableSecretRows.length,
      ),
    },
  );
}

function eagerStoredConnectorSecretNames(args: {
  readonly snapshot: StoredConnectorMaterializationSnapshot;
  readonly storedEnvironment: Record<string, string> | undefined;
  readonly referencedEnvironmentSecretAliases: ReadonlySet<string>;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly overriddenSecretAliases: ReadonlySet<string>;
}): ReadonlySet<string> {
  const names = new Set<string>();

  for (const { runtimeBindings } of args.snapshot.bindingSets) {
    for (const { envName, source } of runtimeBindings) {
      const isNeededByStoredEnvironment =
        args.storedEnvironment?.[envName] !== undefined;
      const isNeededByExplicitEnvironment =
        args.referencedEnvironmentSecretAliases.has(envName);
      if (
        source.kind !== "connector-secret" ||
        (!isNeededByStoredEnvironment && !isNeededByExplicitEnvironment) ||
        args.environmentSecretPlaceholders?.[envName] !== undefined ||
        args.overriddenSecretAliases.has(envName)
      ) {
        continue;
      }
      names.add(source.name);
    }
  }
  return names;
}

async function materializeEagerStoredConnectorSecrets(
  db: Db,
  snapshot: StoredConnectorMaterializationSnapshot | null,
  context: ConnectorRuntimeContext,
  args: {
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly eagerStoredEnvironment: Record<string, string> | undefined;
    readonly referencedEnvironmentSecretAliases: ReadonlySet<string>;
    readonly environmentSecretPlaceholders:
      | Readonly<Record<string, string>>
      | undefined;
    readonly overriddenSecretAliases: ReadonlySet<string>;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<ConnectorRuntimeContext> {
  if (!snapshot) {
    return context;
  }

  const eagerNames = eagerStoredConnectorSecretNames({
    snapshot,
    storedEnvironment: args.eagerStoredEnvironment,
    referencedEnvironmentSecretAliases: args.referencedEnvironmentSecretAliases,
    environmentSecretPlaceholders: args.environmentSecretPlaceholders,
    overriddenSecretAliases: args.overriddenSecretAliases,
  });
  if (eagerNames.size === 0) {
    return context;
  }

  const encryptedRows = await loadStoredConnectorEncryptedSecretRows(db, {
    bindingSets: snapshot.bindingSets,
    names: eagerNames,
  });
  const connectorSecrets = await decryptStoredConnectorSecretRows(
    encryptedRows,
    {
      featureSwitchContext: args.featureSwitchContext,
      timingDimensions: args.timingDimensions,
    },
    timing,
  );
  const resolved = resolveStoredConnectorState(
    snapshot.bindingSets,
    connectorSecrets,
    snapshot.variableValues,
    availableStoredConnectorSecretNames(snapshot.secretRows),
  );

  return {
    ...context,
    secrets: mergeRecords(context.secrets, resolved.secrets),
  };
}

function eagerStoredConnectorSecretInputs(args: {
  readonly content: AgentComposeContent;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: ConnectorRuntimeContext;
}): {
  readonly eagerStoredEnvironment: Record<string, string> | undefined;
  readonly referencedEnvironmentSecretAliases: ReadonlySet<string>;
} {
  const additionalEnvironment = args.modelProvider?.environment;
  return {
    eagerStoredEnvironment: effectiveStoredConnectorEnvironment({
      content: args.content,
      additionalEnvironment,
      storedConnectorEnvironment: args.connectorContext.storedEnvironment,
    }),
    referencedEnvironmentSecretAliases: referencedEnvironmentSecretAliases(
      environmentTemplates({
        content: args.content,
        additionalEnvironment,
      }),
    ),
  };
}

async function loadStoredConnectorMaterializationPlan(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedConnectorSlugs: readonly ConnectorSlug[] | undefined;
    readonly scopeSource: ConnectorScopeSource;
    readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<StoredConnectorMaterializationSnapshot | null> {
  if (args.allowedConnectorSlugs?.length === 0) {
    return null;
  }

  const allowedConnectorSlugs = args.allowedConnectorSlugs
    ? [...new Set(args.allowedConnectorSlugs)]
    : undefined;

  const snapshot = await loadStoredConnectorMaterializationSnapshot(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      allowedConnectorSlugs,
      scopeSource: args.scopeSource,
      connectorCatalogSnapshot: args.connectorCatalogSnapshot,
    },
    timing,
  );
  return snapshot;
}

function storedConnectorSnapshotQuery(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedConnectorSlugs: readonly ConnectorSlug[] | undefined;
  },
) {
  const selectedConnectors = db.$with("stored_connector_candidates").as(
    db
      .select({
        connectorId: connectors.id,
        connectorSlug: sql`${connectors.connectorSlug}`
          .mapWith(pgTextDecoder)
          .as("connector_slug"),
        authMethod: connectors.authMethod,
        connectorStateRevision: sql`(
            EXTRACT(EPOCH FROM ${connectors.updatedAt})
            * 1000000
          )::bigint`
          .mapWith(pgInt8ToBigIntDecoder)
          .as("connector_state_revision"),
        needsReconnect: connectors.needsReconnect,
        orgId: connectors.orgId,
        storageVersion: connectors.storageVersion,
        tokenExpiresAt: connectors.tokenExpiresAt,
        userId: connectors.userId,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          isNotNull(connectors.connectorSlug),
          args.allowedConnectorSlugs
            ? inArray(connectors.connectorSlug, args.allowedConnectorSlugs)
            : undefined,
        ),
      ),
  );
  const secretGroups = db
    .select({
      connectorId: secretsTable.connectorId,
      secretNames: sql`jsonb_agg(${secretsTable.name})`
        .mapWith(storedConnectorSecretNamesDecoder)
        .as("secret_names"),
    })
    .from(secretsTable)
    .innerJoin(
      selectedConnectors,
      and(
        eq(selectedConnectors.connectorId, secretsTable.connectorId),
        eq(secretsTable.orgId, args.orgId),
        eq(secretsTable.userId, args.userId),
      ),
    )
    .where(eq(secretsTable.type, "connector"))
    .groupBy(secretsTable.connectorId)
    .as("stored_connector_secret_groups");
  const variableGroups = db
    .select({
      connectorId: variables.connectorId,
      variableValues:
        sql`jsonb_object_agg(${variables.name}, ${variables.value})`
          .mapWith(storedConnectorVariableValuesDecoder)
          .as("variable_values"),
    })
    .from(variables)
    .innerJoin(
      selectedConnectors,
      and(
        eq(selectedConnectors.connectorId, variables.connectorId),
        eq(variables.orgId, args.orgId),
        eq(variables.userId, args.userId),
      ),
    )
    .where(eq(variables.type, "connector"))
    .groupBy(variables.connectorId)
    .as("stored_connector_variable_groups");
  return db
    .with(selectedConnectors)
    .select({
      connectorId: selectedConnectors.connectorId,
      connectorSlug: selectedConnectors.connectorSlug,
      authMethod: selectedConnectors.authMethod,
      connectorStateRevision: selectedConnectors.connectorStateRevision,
      needsReconnect: selectedConnectors.needsReconnect,
      orgId: selectedConnectors.orgId,
      storageVersion: selectedConnectors.storageVersion,
      tokenExpiresAt: selectedConnectors.tokenExpiresAt,
      userId: selectedConnectors.userId,
      secretNames: sql`COALESCE(${secretGroups.secretNames}, '[]'::jsonb)`
        .mapWith(storedConnectorSecretNamesDecoder)
        .as("secret_names"),
      variableValues:
        sql`COALESCE(${variableGroups.variableValues}, '{}'::jsonb)`
          .mapWith(storedConnectorVariableValuesDecoder)
          .as("variable_values"),
    })
    .from(selectedConnectors)
    .leftJoin(
      secretGroups,
      eq(secretGroups.connectorId, selectedConnectors.connectorId),
    )
    .leftJoin(
      variableGroups,
      eq(variableGroups.connectorId, selectedConnectors.connectorId),
    );
}

async function loadStoredConnectorSnapshotRows(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedConnectorSlugs: readonly ConnectorSlug[] | undefined;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<readonly StoredConnectorMaterializationSnapshotRow[]> {
  const startedAt = now();
  const rows = await onRejection(storedConnectorSnapshotQuery(db, args), () => {
    timing?.recordElapsed(
      "api_dispatch_prepare_context_load_stored_connector_snapshot_rows",
      "nested",
      startedAt,
      now(),
      args.timingDimensions,
    );
  });
  timing?.recordElapsed(
    "api_dispatch_prepare_context_load_stored_connector_snapshot_rows",
    "nested",
    startedAt,
    now(),
    {
      ...args.timingDimensions,
      stored_connector_candidate_count_bucket: countBucket(rows.length),
    },
  );
  return rows;
}

function buildStoredConnectorMaterializationPlan(args: {
  readonly connectorRows: readonly StoredConnectorRuntimeRowCandidate[];
  readonly allowedConnectorSlugs: readonly ConnectorSlug[] | undefined;
  readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
}): StoredConnectorMaterializationPlan | null {
  const allowedConnectorRows = allowedStoredConnectorRows(
    args.connectorRows,
    args.allowedConnectorSlugs,
    args.connectorCatalogSnapshot,
    nowDate(),
  );
  if (allowedConnectorRows.length === 0) {
    return null;
  }

  const bindingSets = connectorEnvBindingSets(allowedConnectorRows);
  return {
    allowedConnectorRows,
    bindingSets,
  };
}

function materializeStoredConnectorSnapshotRows(
  args: {
    readonly rows: readonly StoredConnectorMaterializationSnapshotRow[];
    readonly allowedConnectorSlugs: readonly ConnectorSlug[] | undefined;
    readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): StoredConnectorMaterializationSnapshot | null {
  const startedAt = now();
  const result = safeSync(() => {
    const plan = buildStoredConnectorMaterializationPlan({
      connectorRows: args.rows,
      allowedConnectorSlugs: args.allowedConnectorSlugs,
      connectorCatalogSnapshot: args.connectorCatalogSnapshot,
    });
    if (!plan) {
      return null;
    }

    const requirementsByConnector = storedConnectorRequirementsByConnector(
      plan.bindingSets,
    );
    const secretRows: StoredConnectorSecretRow[] = [];
    const variableValues: Record<string, string> = {};
    for (const row of args.rows) {
      const requirements = requirementsByConnector.get(row.connectorId);
      if (!requirements) {
        continue;
      }
      for (const name of row.secretNames) {
        if (requirements.secretNames.has(name)) {
          secretRows.push({ name });
        }
      }
      for (const [name, value] of Object.entries(row.variableValues)) {
        if (requirements.variableNames.has(name)) {
          variableValues[name] = value;
        }
      }
    }

    return {
      allowedConnectorRows: plan.allowedConnectorRows,
      bindingSets: plan.bindingSets,
      secretRows,
      variableValues,
    } satisfies StoredConnectorMaterializationSnapshot;
  });
  if ("error" in result) {
    timing?.recordElapsed(
      "api_dispatch_prepare_context_materialize_stored_connector_snapshot",
      "nested",
      startedAt,
      now(),
      {
        ...args.timingDimensions,
        stored_connector_candidate_count_bucket: countBucket(args.rows.length),
      },
    );
    throw result.error;
  }
  const snapshot = result.ok;
  timing?.recordElapsed(
    "api_dispatch_prepare_context_materialize_stored_connector_snapshot",
    "nested",
    startedAt,
    now(),
    {
      ...args.timingDimensions,
      stored_connector_candidate_count_bucket: countBucket(args.rows.length),
      stored_connector_count_bucket: countBucket(
        snapshot?.allowedConnectorRows.length ?? 0,
      ),
      stored_connector_secret_count_bucket: countBucket(
        snapshot?.secretRows.length ?? 0,
      ),
    },
  );
  return snapshot;
}

async function loadStoredConnectorMaterializationSnapshot(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedConnectorSlugs: readonly ConnectorSlug[] | undefined;
    readonly scopeSource: ConnectorScopeSource;
    readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<StoredConnectorMaterializationSnapshot | null> {
  const baseTimingDimensions = storedConnectorTimingDimensions({
    scopeSource: args.scopeSource,
  });
  const rows = await loadStoredConnectorSnapshotRows(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      allowedConnectorSlugs: args.allowedConnectorSlugs,
      timingDimensions: baseTimingDimensions,
    },
    timing,
  );
  if (rows.length === 0) {
    return null;
  }

  return materializeStoredConnectorSnapshotRows(
    {
      rows,
      allowedConnectorSlugs: args.allowedConnectorSlugs,
      connectorCatalogSnapshot: args.connectorCatalogSnapshot,
      timingDimensions: baseTimingDimensions,
    },
    timing,
  );
}

export type CustomConnectorRuntimeDataRows = Awaited<
  ReturnType<typeof loadCustomConnectorRuntimeData>
>;

type CustomConnectorRuntimeBuildPhase =
  | "decryptValues"
  | "renderAuthTemplates"
  | "renderPrefixes"
  | "assembleFirewalls";

const CUSTOM_CONNECTOR_RUNTIME_BUILD_PHASE_TIMINGS = [
  {
    phase: "decryptValues",
    actionType: "api_dispatch_prepare_context_decrypt_custom_connector_values",
  },
  {
    phase: "renderAuthTemplates",
    actionType:
      "api_dispatch_prepare_context_render_custom_connector_auth_templates",
  },
  {
    phase: "renderPrefixes",
    actionType: "api_dispatch_prepare_context_render_custom_connector_prefixes",
  },
  {
    phase: "assembleFirewalls",
    actionType:
      "api_dispatch_prepare_context_assemble_custom_connector_firewalls",
  },
] as const satisfies readonly {
  readonly phase: CustomConnectorRuntimeBuildPhase;
  readonly actionType: ApiDispatchTimingActionType;
}[];

class CustomConnectorRuntimeBuildStats {
  private readonly phaseDurationsMs: Record<
    CustomConnectorRuntimeBuildPhase,
    number
  > = {
    decryptValues: 0,
    renderAuthTemplates: 0,
    renderPrefixes: 0,
    assembleFirewalls: 0,
  };

  private readonly connectorCount: number;
  private readonly configuredValueCount: number;
  private readonly prefixTemplateCount: number;
  private decryptedValueCount = 0;
  private renderedApiCount = 0;
  private missingRequiredCount = 0;
  private noAuthInjectionCount = 0;
  private invalidPrefixCount = 0;
  private pinnedRoutingCount = 0;
  private unpinnedRoutingCount = 0;

  constructor(rows: CustomConnectorRuntimeDataRows) {
    this.connectorCount = rows.length;
    this.configuredValueCount = rows.reduce((total, row) => {
      return total + row.values.length;
    }, 0);
    this.prefixTemplateCount = rows.reduce((total, row) => {
      return total + row.connector.prefixTemplates.length;
    }, 0);
  }

  recordPhaseDuration(
    phase: CustomConnectorRuntimeBuildPhase,
    startedAt: number,
    finishedAt: number = now(),
  ): void {
    this.phaseDurationsMs[phase] += Math.max(0, finishedAt - startedAt);
  }

  recordDecryptedValues(count: number): void {
    this.decryptedValueCount += count;
  }

  recordRenderedApi(): void {
    this.renderedApiCount += 1;
  }

  recordMissingRequiredConnector(): void {
    this.missingRequiredCount += 1;
  }

  recordNoAuthInjectionConnector(): void {
    this.noAuthInjectionCount += 1;
  }

  recordInvalidPrefix(): void {
    this.invalidPrefixCount += 1;
  }

  recordTarget(
    target: Extract<
      ConnectorRuntimeTargetRegistration,
      { readonly kind: "custom" }
    >,
  ): void {
    if (target.baseUrlVars === undefined) {
      this.unpinnedRoutingCount += 1;
    } else {
      this.pinnedRoutingCount += 1;
    }
  }

  flush(timing: ApiDispatchTimingCollector | undefined): void {
    if (!timing) {
      return;
    }
    const dimensions = this.dimensions();
    const finishedAt = now();
    for (const {
      phase,
      actionType,
    } of CUSTOM_CONNECTOR_RUNTIME_BUILD_PHASE_TIMINGS) {
      const durationMs = this.phaseDurationsMs[phase];
      timing.recordElapsed(
        actionType,
        "nested",
        finishedAt - durationMs,
        finishedAt,
        dimensions,
      );
    }
  }

  private dimensions(): ApiDispatchTimingDimensions {
    return {
      custom_connector_runtime_connector_count_bucket: countBucket(
        this.connectorCount,
      ),
      custom_connector_runtime_configured_value_count_bucket: countBucket(
        this.configuredValueCount,
      ),
      custom_connector_runtime_decrypted_value_count_bucket: countBucket(
        this.decryptedValueCount,
      ),
      custom_connector_runtime_prefix_template_count_bucket: countBucket(
        this.prefixTemplateCount,
      ),
      custom_connector_runtime_rendered_api_count_bucket: countBucket(
        this.renderedApiCount,
      ),
      custom_connector_runtime_missing_required_count_bucket: countBucket(
        this.missingRequiredCount,
      ),
      custom_connector_runtime_no_auth_injection_count_bucket: countBucket(
        this.noAuthInjectionCount,
      ),
      custom_connector_runtime_invalid_prefix_count_bucket: countBucket(
        this.invalidPrefixCount,
      ),
      custom_connector_runtime_pinned_routing_count_bucket: countBucket(
        this.pinnedRoutingCount,
      ),
      custom_connector_runtime_unpinned_routing_count_bucket: countBucket(
        this.unpinnedRoutingCount,
      ),
    };
  }
}

function customConnectorRuntimeAuth(args: {
  readonly connector: CustomConnectorRuntimeDataRows[number]["connector"];
}): {
  readonly headers: Record<string, string>;
  readonly query: Record<string, string>;
} {
  return {
    headers: Object.fromEntries(
      args.connector.headerInjections.flatMap((header) => {
        const rendered = renderTemplateForRuntime({
          template: header.valueTemplate,
          connectorId: args.connector.id,
          fields: args.connector.fields,
        });
        return rendered === null ? [] : [[header.name, rendered]];
      }),
    ),
    query: Object.fromEntries(
      args.connector.queryInjections.flatMap((queryInjection) => {
        const rendered = renderTemplateForRuntime({
          template: queryInjection.valueTemplate,
          connectorId: args.connector.id,
          fields: args.connector.fields,
        });
        return rendered === null ? [] : [[queryInjection.name, rendered]];
      }),
    ),
  };
}

function buildCustomConnectorRuntimeApis(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly headers: Record<string, string>;
  readonly query: Record<string, string>;
  readonly baseUrlVars: Readonly<Record<string, string>> | undefined;
  readonly permissionBundle: CustomConnectorPermissionBundle | null;
  readonly stats: CustomConnectorRuntimeBuildStats;
}): ExpandedFirewallConfig["apis"] {
  if (args.baseUrlVars === undefined) {
    return [];
  }
  const templateValues = Object.fromEntries(
    Object.entries(args.baseUrlVars).map(([key, value]) => {
      return [customConnectorValueMarkerKey({ kind: "variable", key }), value];
    }),
  );

  const apis: ExpandedFirewallConfig["apis"] = [];
  const prefixStartedAt = now();
  for (const prefixTemplate of args.row.connector.prefixTemplates) {
    const renderedPrefix = renderCustomConnectorRuntimePrefix({
      template: prefixTemplate,
      values: templateValues,
      connectorName: args.row.connector.displayName,
    });
    if (!renderedPrefix) {
      args.stats.recordInvalidPrefix();
      continue;
    }
    args.stats.recordRenderedApi();
    apis.push({
      base: renderedPrefix,
      auth: { headers: args.headers, query: args.query },
      ...(args.permissionBundle
        ? { permissions: [...args.permissionBundle.permissions] }
        : {}),
    });
  }
  args.stats.recordPhaseDuration("renderPrefixes", prefixStartedAt);
  return apis;
}

async function resolveCustomConnectorBaseUrlVars(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly provided: Readonly<Record<string, string>> | undefined;
  readonly hasProvided: boolean;
  readonly stats: CustomConnectorRuntimeBuildStats;
}): Promise<Readonly<Record<string, string>> | undefined> {
  const variableKeys = [
    ...customConnectorPrefixTemplateVariableKeys(
      args.row.connector.prefixTemplates,
    ),
  ].sort();
  if (args.hasProvided) {
    const provided = args.provided ?? {};
    const providedKeys = Object.keys(provided).sort();
    return jsonArrayEqual(variableKeys, providedKeys)
      ? { ...provided }
      : undefined;
  }
  if (variableKeys.length === 0) {
    return {};
  }
  const prefixValues = args.row.values.filter((value) => {
    return value.kind === "variable" && variableKeys.includes(value.key);
  });
  if (prefixValues.length !== variableKeys.length) {
    return undefined;
  }
  const decryptStartedAt = now();
  const decryptedValues = await decryptCustomConnectorValues({
    values: prefixValues,
    featureSwitchContext: args.featureSwitchContext,
  });
  args.stats.recordPhaseDuration("decryptValues", decryptStartedAt);
  args.stats.recordDecryptedValues(prefixValues.length);
  const baseUrlVars: Record<string, string> = {};
  for (const key of variableKeys) {
    const value =
      decryptedValues[customConnectorValueMarkerKey({ kind: "variable", key })];
    if (value === undefined) {
      return undefined;
    }
    baseUrlVars[key] = value;
  }
  return baseUrlVars;
}

function jsonArrayEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      return value === right[index];
    })
  );
}

interface BuildCustomConnectorRuntimeContextArgs {
  readonly rows: CustomConnectorRuntimeDataRows;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
  readonly grants: readonly AgentCustomConnectorGrant[] | undefined;
  readonly baseUrlVarsByConnectorId?: ReadonlyMap<
    string,
    Readonly<Record<string, string>>
  >;
  readonly timing?: ApiDispatchTimingCollector;
}

interface BuiltCustomConnectorRuntimeRow {
  readonly target: Extract<
    ConnectorRuntimeTargetRegistration,
    { readonly kind: "custom" }
  >;
  readonly skill: CustomConnectorRuntimeContext["skills"][number] | undefined;
  readonly firewall: ExpandedFirewallConfig | undefined;
  readonly permissionPolicy: FirewallPolicy | undefined;
}

function customConnectorRuntimeSkill(
  row: CustomConnectorRuntimeDataRows[number],
): CustomConnectorRuntimeContext["skills"][number] | undefined {
  return row.connector.skillMarkdown === null
    ? undefined
    : {
        connectorId: row.connector.id,
        connectorSlug: row.connector.slug,
      };
}

function customConnectorRuntimeCredentialsAreComplete(
  row: CustomConnectorRuntimeDataRows[number],
): boolean {
  const valueMarkers = new Set(
    row.values.map((value) => {
      return customConnectorValueMarkerKey(value);
    }),
  );
  const oauthConnected = valueMarkers.has(
    customConnectorValueMarkerKey({
      kind: "secret",
      key: CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY,
    }),
  );
  return (
    (row.connector.authMode !== "oauth" || oauthConnected) &&
    row.connector.fields.every((field) => {
      return (
        !field.required ||
        valueMarkers.has(customConnectorValueMarkerKey(field))
      );
    })
  );
}

function unavailableCustomConnectorRuntimeRow(
  target: BuiltCustomConnectorRuntimeRow["target"],
  skill: BuiltCustomConnectorRuntimeRow["skill"],
): BuiltCustomConnectorRuntimeRow {
  return {
    target,
    skill,
    firewall: undefined,
    permissionPolicy: undefined,
  };
}

export async function loadEffectiveCustomConnectorPermissionBundle(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly snapshot: ConnectorRuntimeSnapshot;
}): Promise<CustomConnectorPermissionBundle | null | undefined> {
  const ref = effectiveCustomConnectorPermissionBundleRef({
    slug: args.row.connector.slug,
    authMode: args.row.connector.authMode,
    oauthProviderAdapter:
      args.row.connector.oauthConfig?.providerAdapter ?? null,
    prefixTemplates: args.row.connector.prefixTemplates,
    permissionBundleRef: args.row.connector.permissionBundleRef,
  });
  return ref
    ? ((await loadCustomConnectorPermissionBundle({
        snapshot: args.snapshot,
        ref,
      })) ?? undefined)
    : null;
}

function buildCustomConnectorPermissionPolicy(args: {
  readonly bundle: CustomConnectorPermissionBundle;
  readonly selectedPermissionNames: readonly string[];
}): FirewallPolicy {
  const selectedPermissionNames = new Set(args.selectedPermissionNames);
  return {
    policies: Object.fromEntries(
      [...args.bundle.permissionNames].map((permissionName) => {
        return [
          permissionName,
          selectedPermissionNames.has(permissionName)
            ? "allow"
            : (args.bundle.defaultPolicies[permissionName] ?? "deny"),
        ];
      }),
    ),
    unknownPolicy: "deny",
  };
}

async function buildCustomConnectorRuntimeRow(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly context: BuildCustomConnectorRuntimeContextArgs;
  readonly selectedPermissionNames: readonly string[];
  readonly stats: CustomConnectorRuntimeBuildStats;
}): Promise<BuiltCustomConnectorRuntimeRow> {
  const hasProvidedBaseUrlVars =
    args.context.baseUrlVarsByConnectorId?.has(args.row.connector.id) ?? false;
  const baseUrlVars = await resolveCustomConnectorBaseUrlVars({
    row: args.row,
    featureSwitchContext: args.context.featureSwitchContext,
    provided: args.context.baseUrlVarsByConnectorId?.get(args.row.connector.id),
    hasProvided: hasProvidedBaseUrlVars,
    stats: args.stats,
  });
  const targetIdentity = {
    kind: "custom" as const,
    customConnectorId: args.row.connector.id,
  };
  const target: BuiltCustomConnectorRuntimeRow["target"] = {
    ...targetIdentity,
    ...(baseUrlVars === undefined ? {} : { baseUrlVars: { ...baseUrlVars } }),
  };
  const skill = customConnectorRuntimeSkill(args.row);
  const missingRequiredStartedAt = now();
  const missingRequired = !customConnectorRuntimeCredentialsAreComplete(
    args.row,
  );
  args.stats.recordPhaseDuration("assembleFirewalls", missingRequiredStartedAt);
  if (missingRequired) {
    args.stats.recordMissingRequiredConnector();
  }
  const authTemplateStartedAt = now();
  const { headers, query } = customConnectorRuntimeAuth({
    connector: args.row.connector,
  });
  args.stats.recordPhaseDuration("renderAuthTemplates", authTemplateStartedAt);
  if (Object.keys(headers).length === 0 && Object.keys(query).length === 0) {
    args.stats.recordNoAuthInjectionConnector();
  }
  const permissionBundle = await loadEffectiveCustomConnectorPermissionBundle({
    row: args.row,
    snapshot: args.context.connectorCatalogSnapshot,
  });
  if (permissionBundle === undefined) {
    return unavailableCustomConnectorRuntimeRow(target, skill);
  }
  const apisResult = safeSync(() => {
    return buildCustomConnectorRuntimeApis({
      row: args.row,
      headers,
      query,
      baseUrlVars,
      permissionBundle,
      stats: args.stats,
    });
  });
  if ("error" in apisResult) {
    if (!(apisResult.error instanceof CustomConnectorRuntimePrefixError)) {
      throw apisResult.error;
    }
    args.stats.recordInvalidPrefix();
    return unavailableCustomConnectorRuntimeRow(targetIdentity, skill);
  }
  const apis = apisResult.ok;
  if (apis.length === 0) {
    return unavailableCustomConnectorRuntimeRow(target, skill);
  }
  return {
    target,
    skill,
    firewall: {
      name: customConnectorInternalName(args.row.connector.id),
      description: args.row.connector.displayName,
      apis,
    },
    permissionPolicy: permissionBundle
      ? buildCustomConnectorPermissionPolicy({
          bundle: permissionBundle,
          selectedPermissionNames: args.selectedPermissionNames,
        })
      : undefined,
  };
}

export async function buildCustomConnectorRuntimeContext(
  args: BuildCustomConnectorRuntimeContextArgs,
): Promise<CustomConnectorRuntimeContext> {
  const firewalls: ExpandedFirewallConfig[] = [];
  const reservedSecretAliases: Record<string, true> = {};
  const permissionPolicies: FirewallPolicies = {};
  const targets: ConnectorRuntimeTargetRegistration[] = [];
  const customConnectorIdByFirewallName: Record<string, string> = {};
  const skills: {
    connectorId: string;
    connectorSlug: string;
  }[] = [];
  const grantByConnectorId = new Map(
    (args.grants ?? []).map((grant) => {
      return [grant.customConnectorId, grant.permissionNames] as const;
    }),
  );
  const stats = new CustomConnectorRuntimeBuildStats(args.rows);
  for (const row of args.rows) {
    const built = await buildCustomConnectorRuntimeRow({
      row,
      context: args,
      selectedPermissionNames: grantByConnectorId.get(row.connector.id) ?? [],
      stats,
    });
    const assemblyStartedAt = now();
    stats.recordTarget(built.target);
    targets.push(built.target);
    if (built.skill) {
      skills.push(built.skill);
    }
    if (!built.firewall) {
      stats.recordPhaseDuration("assembleFirewalls", assemblyStartedAt);
      continue;
    }
    firewalls.push(built.firewall);
    customConnectorIdByFirewallName[built.firewall.name] = row.connector.id;
    if (built.permissionPolicy) {
      permissionPolicies[built.firewall.name] = built.permissionPolicy;
    }
    for (const secretName of extractSecretNamesFromApis(built.firewall.apis)) {
      reservedSecretAliases[secretName] = true;
    }
    stats.recordPhaseDuration("assembleFirewalls", assemblyStartedAt);
  }

  const finalAssemblyStartedAt = now();
  const result = {
    firewalls,
    reservedSecretAliases: compactRecord(reservedSecretAliases),
    permissionPolicies: compactRecord(permissionPolicies),
    targets,
    customConnectorIdByFirewallName,
    skills,
  };
  stats.recordPhaseDuration("assembleFirewalls", finalAssemblyStartedAt);
  stats.flush(args.timing);
  return result;
}

async function buildNewRunCustomConnectorRuntimeContext(
  args: BuildCustomConnectorRuntimeContextArgs,
): Promise<CustomConnectorRuntimeContext> {
  // Active targets call the shared builder directly so credential loss does
  // not remove their pinned firewall. Only new runs apply this admission gate.
  const context = await buildCustomConnectorRuntimeContext({
    ...args,
    rows: args.rows.filter((row) => {
      return (
        row.credentialAccess.kind === "current" &&
        customConnectorRuntimeCredentialsAreComplete(row)
      );
    }),
  });
  const admittedConnectorIds = new Set(
    Object.values(context.customConnectorIdByFirewallName),
  );
  return {
    ...context,
    targets: context.targets.filter((target) => {
      return (
        target.kind === "custom" &&
        target.baseUrlVars !== undefined &&
        admittedConnectorIds.has(target.customConnectorId)
      );
    }),
    skills: args.rows.flatMap((row) => {
      const skill = customConnectorRuntimeSkill(row);
      return skill ? [skill] : [];
    }),
  };
}

interface CustomConnectorRuntimeExecutionState {
  readonly firewall: Omit<ExecutionFirewallInlineEntry, "firewall"> & {
    readonly customConnectorId: string;
    readonly firewall: Omit<Firewall, "apis"> & {
      readonly apis: (Firewall["apis"][number] & {
        readonly id: string;
      })[];
    };
  };
  readonly networkPolicy: NetworkPolicy;
}

export function customConnectorRuntimeExecutionState(args: {
  readonly context: CustomConnectorRuntimeContext;
  readonly connectorId: string;
}): CustomConnectorRuntimeExecutionState | null {
  const firewallName = customConnectorInternalName(args.connectorId);
  const source = args.context.firewalls.find((firewall) => {
    return firewall.name === firewallName;
  });
  if (!source) {
    return null;
  }

  const permissionNames = collectPermissionNames(source.apis);
  const defaultPolicy = allAllowPolicyForPermissions(permissionNames);
  const policy = args.context.permissionPolicies?.[firewallName];
  const networkPolicy = resolveConnectorNetworkPolicy({
    permissionNames,
    defaultPolicy,
    policy,
  });

  return {
    firewall: {
      kind: "inline",
      customConnectorId: args.connectorId,
      firewall: {
        name: source.name,
        apis: source.apis.map((api, index) => {
          return {
            id: `${firewallName}:${index}`,
            base: api.base,
            ...(api.hostPolicy !== undefined
              ? { hostPolicy: api.hostPolicy }
              : {}),
            auth: api.auth,
            permissions: api.permissions ?? [],
          };
        }),
      },
    },
    networkPolicy,
  };
}

async function loadCustomConnectorContext(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedCustomConnectorIds: readonly string[] | undefined;
    readonly customConnectorGrants:
      | readonly AgentCustomConnectorGrant[]
      | undefined;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
  },
  signal: AbortSignal,
  timing?: ApiDispatchTimingCollector,
): Promise<CustomConnectorRuntimeContext> {
  if (args.allowedCustomConnectorIds?.length === 0) {
    return {
      firewalls: [],
      reservedSecretAliases: undefined,
      permissionPolicies: undefined,
      targets: [],
      customConnectorIdByFirewallName: {},
      skills: [],
    };
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
    return {
      firewalls: [],
      reservedSecretAliases: undefined,
      permissionPolicies: undefined,
      targets: [],
      customConnectorIdByFirewallName: {},
      skills: [],
    };
  }
  const refreshedRows: CustomConnectorRuntimeDataRows[number][] = [];
  for (const row of rows) {
    refreshedRows.push({
      connector: row.connector,
      credentialAccess: row.credentialAccess,
      values: await refreshCustomConnectorOAuth2ValuesIfNeeded(
        {
          db,
          orgId: args.orgId,
          userId: args.userId,
          connector: row.connector,
          values: row.values,
          featureContext: args.featureSwitchContext,
        },
        signal,
      ),
    });
    signal.throwIfAborted();
  }

  return await measureApiDispatchTiming(
    timing,
    "api_dispatch_prepare_context_build_custom_connector_firewalls",
    "nested",
    async () => {
      return await buildNewRunCustomConnectorRuntimeContext({
        rows: refreshedRows,
        featureSwitchContext: args.featureSwitchContext,
        connectorCatalogSnapshot: args.connectorCatalogSnapshot,
        grants: args.customConnectorGrants,
        timing,
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

function resolveConnectorNetworkPolicy(args: {
  readonly permissionNames: readonly string[];
  readonly defaultPolicy: FirewallPolicy;
  readonly policy: FirewallPolicy | undefined;
}): NetworkPolicy {
  return networkPolicyForFirewallPolicy(
    args.permissionNames,
    args.policy
      ? {
          ...args.policy,
          unknownPolicy:
            args.policy.unknownPolicy ?? args.defaultPolicy.unknownPolicy,
        }
      : args.defaultPolicy,
  );
}

async function loadRequiredFirewallPermissionIndex(args: {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly connectorSlug: string;
}): Promise<ConnectorServerFirewallPermissionIndex> {
  const index = await args.snapshot.serverFirewalls.loadPermissionIndex(
    args.connectorSlug,
  );
  if (!index) {
    throw new Error(
      `Missing connector server firewall permission metadata: ${args.connectorSlug}`,
    );
  }
  return index;
}

function getRequiredFirewallExecutionMetadata(
  snapshot: ConnectorRuntimeSnapshot,
  connectorSlug: string,
): ConnectorServerFirewallExecutionMetadata {
  const metadata = snapshot.serverFirewalls.getExecutionMetadata(connectorSlug);
  if (!metadata) {
    throw new Error(
      `Missing connector server firewall execution metadata: ${connectorSlug}`,
    );
  }
  return metadata;
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

  const baseUrlVars = canonicalizeFirewallBaseUrlVarsForExecution(
    [runtimeFirewall(firewall)],
    vars,
  );
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
  metadata: ConnectorServerFirewallExecutionMetadata,
  vars: Record<string, string> | undefined,
): ExecutionFirewallEntry {
  if (metadata.baseUrlVarNames.length === 0) {
    return { kind: "builtin", name: metadata.connectorSlug };
  }

  const validationFirewall: Firewall = {
    name: metadata.connectorSlug,
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
  };
  const baseUrlVars = canonicalizeFirewallBaseUrlVarsForExecution(
    [validationFirewall],
    vars,
  );
  return { kind: "builtin", name: metadata.connectorSlug, baseUrlVars };
}

function inlineFirewallEntry(
  firewall: ExpandedFirewallConfig,
): ExecutionFirewallEntry {
  return { kind: "inline", firewall: runtimeFirewall(firewall) };
}

function customConnectorInlineFirewallEntry(
  firewall: ExpandedFirewallConfig,
  customConnectorIdByFirewallName: Readonly<Record<string, string>>,
): ExecutionFirewallEntry {
  const customConnectorId = customConnectorIdByFirewallName[firewall.name];
  if (!customConnectorId) {
    throw new Error("Missing Custom connector identity for inline firewall");
  }
  return {
    kind: "inline",
    customConnectorId,
    firewall: runtimeFirewall(firewall),
  };
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

    networkPolicies[firewall.name] = resolveConnectorNetworkPolicy({
      permissionNames,
      defaultPolicy,
      policy,
    });
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

  const firewall =
    modelProvider.firewall ??
    getModelProviderFirewall(modelProvider.concreteType ?? modelProvider.type);
  if (!firewall) {
    return undefined;
  }

  const permissionNames = collectPermissionNames(firewall.apis);
  const denySet = new Set(firewall.defaultPolicies?.deny ?? []);
  const askSet = new Set(firewall.defaultPolicies?.ask ?? []);
  return {
    firewalls: [
      modelProvider.inlineFirewall
        ? inlineFirewallEntry(firewall)
        : builtinFirewallEntry(firewall, vars),
    ],
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
  readonly metadata: ConnectorServerFirewallExecutionMetadata;
  readonly permissionIndex: ConnectorServerFirewallPermissionIndex;
}

interface FixedFirewallBaseParts {
  readonly protocol: string;
  readonly authority: string;
  readonly pathPrefix: string;
}

function fixedFirewallBaseParts(base: string): FixedFirewallBaseParts | null {
  const schemeEnd = base.indexOf("://");
  if (schemeEnd === -1) {
    return null;
  }
  const authorityStart = schemeEnd + 3;
  const authorityEnd = base.indexOf("/", authorityStart);
  const rawAuthority = base.slice(
    authorityStart,
    authorityEnd === -1 ? base.length : authorityEnd,
  );
  if (/[${}*]/u.test(rawAuthority)) {
    return null;
  }
  const parsed = safeSync(() => {
    return new URL(base);
  });
  if ("error" in parsed) {
    return null;
  }
  const authority = normalizeFirewallFixedHost(parsed.ok.host);
  if (!authority) {
    return null;
  }
  const pathname = parsed.ok.pathname.endsWith("/")
    ? parsed.ok.pathname
    : `${parsed.ok.pathname}/`;
  return {
    protocol: parsed.ok.protocol.toLowerCase(),
    authority,
    pathPrefix: pathname,
  };
}

function customFirewallCoversBuiltinBase(
  customBase: string,
  builtinBase: string,
): boolean {
  const custom = fixedFirewallBaseParts(customBase);
  const builtin = fixedFirewallBaseParts(builtinBase);
  return (
    custom !== null &&
    builtin !== null &&
    custom.protocol === builtin.protocol &&
    custom.authority === builtin.authority &&
    builtin.pathPrefix.startsWith(custom.pathPrefix)
  );
}

function builtinConnectorOverriddenByCustomFirewalls(args: {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly connectorSlug: ConnectorSlug;
  readonly customFirewalls: readonly ExpandedFirewallConfig[];
}): boolean {
  const metadata = args.snapshot.serverFirewalls.getRoutingIndexMetadata(
    args.connectorSlug,
  );
  if (!metadata) {
    return false;
  }
  return metadata.apis.some((builtinApi) => {
    return args.customFirewalls.some((customFirewall) => {
      return customFirewall.apis.some((customApi) => {
        return customFirewallCoversBuiltinBase(customApi.base, builtinApi.base);
      });
    });
  });
}

function buildConnectorPermissionBaseline(
  snapshot: ConnectorRuntimeSnapshot,
  sources: readonly BuiltinConnectorManifestSource[],
): StoredConnectorPermissionBaseline {
  const validationAuthority = currentConnectorCatalogValidatorIdentity();
  return {
    version: 1,
    catalogIdentity: snapshot.acceptedSnapshot.identity,
    validationAuthority: {
      backendVersion: validationAuthority.backendVersion,
      buildCommitSha: validationAuthority.buildCommitSha,
    },
    connectors: Object.fromEntries(
      sources.map((source) => {
        const defaultPolicy = source.permissionIndex.defaultPolicy;
        const permissionOverrides = defaultPolicy.permissionOverrides;
        return [
          source.metadata.connectorSlug,
          {
            permissionNames: [...source.permissionIndex.permissionNames],
            defaultPolicy: {
              permissionDefault: defaultPolicy.permissionDefault,
              ...(permissionOverrides
                ? {
                    permissionOverrides: {
                      ...(permissionOverrides.allow
                        ? { allow: [...permissionOverrides.allow] }
                        : {}),
                      ...(permissionOverrides.deny
                        ? { deny: [...permissionOverrides.deny] }
                        : {}),
                      ...(permissionOverrides.ask
                        ? { ask: [...permissionOverrides.ask] }
                        : {}),
                    },
                  }
                : {}),
              unknownPolicy: defaultPolicy.unknownPolicy,
            },
          },
        ];
      }),
    ),
  };
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
    const name = source.metadata.connectorSlug;
    const permissionNames = [...source.permissionIndex.permissionNames];
    const defaultPolicy = defaultFirewallPolicyForPermissionIndex(
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

    networkPolicies[name] = resolveConnectorNetworkPolicy({
      permissionNames,
      defaultPolicy,
      policy,
    });
  }

  return {
    firewalls,
    networkPolicies,
    environmentSecretPlaceholders: compactRecord(environmentSecretPlaceholders),
    billableFirewalls,
  };
}

interface BuildPermissionManifestArgs {
  readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly permissionPolicies: FirewallPolicies | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly connectorVars?: Record<string, string>;
  readonly connectorSlugs?: readonly ConnectorSlug[];
  readonly customConnectorFirewalls?: readonly ExpandedFirewallConfig[];
  readonly customConnectorPermissionPolicies?: FirewallPolicies;
  readonly customConnectorIdByFirewallName?: Readonly<Record<string, string>>;
  readonly timing?: ApiDispatchTimingCollector;
}

async function buildPermissionManifest(
  args: BuildPermissionManifestArgs,
): Promise<PermissionManifest | undefined> {
  const connectorSlugs =
    args.connectorSlugs ??
    Object.keys(args.permissionPolicies ?? {}).filter((connectorSlug) => {
      return args.connectorCatalogSnapshot.serverFirewalls.has(connectorSlug);
    });
  const connectorBaseUrlVars = mergeRecords(args.vars, args.connectorVars);
  const customConnectorFirewalls = args.customConnectorFirewalls ?? [];
  // Narrower custom bases already win by base specificity. Remove a built-in
  // only when a custom base covers it, which avoids equal/broader ambiguity.
  const builtinConnectorSlugs = connectorSlugs.filter((connectorSlug) => {
    return (
      args.connectorCatalogSnapshot.serverFirewalls.has(connectorSlug) &&
      !builtinConnectorOverriddenByCustomFirewalls({
        snapshot: args.connectorCatalogSnapshot,
        connectorSlug,
        customFirewalls: customConnectorFirewalls,
      })
    );
  });

  const builtinSources = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_load_builtin_permission_indexes",
    "nested",
    async () => {
      return await Promise.all(
        builtinConnectorSlugs.map(async (connectorSlug) => {
          const metadata = getRequiredFirewallExecutionMetadata(
            args.connectorCatalogSnapshot,
            connectorSlug,
          );
          const permissionIndex = await loadRequiredFirewallPermissionIndex({
            snapshot: args.connectorCatalogSnapshot,
            connectorSlug,
          });
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
      return Promise.resolve(
        applyConnectorPolicies(
          customConnectorFirewalls,
          mergeRecords(
            args.permissionPolicies,
            args.customConnectorPermissionPolicies,
          ),
          (firewall) => {
            return customConnectorInlineFirewallEntry(
              firewall,
              args.customConnectorIdByFirewallName ?? {},
            );
          },
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
        connectorPermissionBaseline: buildConnectorPermissionBaseline(
          args.connectorCatalogSnapshot,
          builtinSources,
        ),
        environmentSecretPlaceholders: mergeRecords(
          providerManifest?.environmentSecretPlaceholders,
          connectorManifest.environmentSecretPlaceholders,
          firewallSecretPlaceholdersFromFirewalls(customConnectorFirewalls),
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

async function checkRunConcurrencyLimit(
  tx: DbTransaction,
  orgId: string,
): Promise<CreateRunErrorResult | null> {
  const at = nowDate();
  const state = await loadOrgConcurrencyState(tx, {
    orgId,
    at,
    activePendingAfter: new Date(at.getTime() - PENDING_RUN_TTL_MS),
  });
  const limit = getEffectiveConcurrencyLimit(
    state.baseConcurrencyLimit,
    state.paidSlots,
  );
  if (limit === 0) {
    return null;
  }

  return state.activeRunCount >= limit ? concurrentRunLimit() : null;
}

async function checkFinalRunAdmission(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly modelProviderType: string | null | undefined;
    readonly selectedModel: string | null | undefined;
    readonly enforceVm0Credits: boolean;
    readonly timing: ApiDispatchTimingCollector;
  },
  signal: AbortSignal,
): Promise<CreateRunErrorResult | null> {
  if (args.enforceVm0Credits) {
    return await args.timing.measure(
      "api_dispatch_check_vm0_credits",
      "nested",
      async () => {
        const availability = await resolveOrgCreditAvailability({
          db,
          orgId: args.orgId,
          userId: args.userId,
        });
        signal.throwIfAborted();
        return (
          (await checkResolvedOrgCreditsForRunAdmission({
            db,
            orgId: args.orgId,
            userId: args.userId,
            modelProviderType: args.modelProviderType,
            selectedModel: args.selectedModel,
            availability,
          })) ?? null
        );
      },
    );
  }

  const capabilities = await loadOrgPlanCapabilities(db, args.orgId);
  signal.throwIfAborted();
  return (
    checkOrgPlanRunAdmission({
      capabilities,
      modelProviderType: args.modelProviderType,
      selectedModel: args.selectedModel,
    }) ?? null
  );
}

async function checkOrgRunPlanStatus(
  db: Db,
  args: { readonly orgId: string },
): Promise<CreateRunErrorResult | null> {
  const capabilities = await loadOrgPlanCapabilities(db, args.orgId);
  if (!capabilities) {
    return insufficientCredits();
  }
  return capabilities.status === "active" ? null : insufficientCredits();
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

interface ResumeSessionSnapshot {
  readonly runId: string;
  readonly cliAgentSessionId: string;
  readonly cliAgentSessionHistory: string | null;
  readonly cliAgentSessionHistoryHash: string | null;
  readonly sessionHistoryBlobEncoding: string | null;
}

function resumeSessionFromSnapshot(
  snapshot: ResumeSessionSnapshot,
): StoredExecutionContext["resumeSession"] | undefined {
  const hash = snapshot.cliAgentSessionHistoryHash;
  let encoding: CompressedSessionHistoryBlobEncoding | undefined;
  if (snapshot.sessionHistoryBlobEncoding !== null) {
    const parsedEncoding = normalizeSessionHistoryBlobEncoding(
      snapshot.sessionHistoryBlobEncoding,
    );
    if (isCompressedSessionHistoryBlobEncoding(parsedEncoding)) {
      encoding = parsedEncoding;
    }
  }
  if (hash) {
    return {
      sessionId: snapshot.cliAgentSessionId,
      historyGenerationRunId: snapshot.runId,
      historyRef: {
        kind: "blob",
        hash,
        ...(encoding ? { encoding } : {}),
      },
    };
  }
  if (snapshot.cliAgentSessionHistory) {
    return {
      sessionId: snapshot.cliAgentSessionId,
      sessionHistory: snapshot.cliAgentSessionHistory,
    };
  }
  return undefined;
}

function resolvedSessionStorage(session: {
  readonly id: string;
  readonly storageMounts: readonly PersistedStorageMount[] | null;
}): Pick<ResolvedCompose, "artifacts" | "persistedStorageMounts"> {
  if (session.storageMounts === null) {
    throw new Error(
      `Agent session "${session.id}" is missing canonical Storage mounts`,
    );
  }
  return {
    artifacts: projectLegacyWritebackArtifacts(session.storageMounts),
    persistedStorageMounts: session.storageMounts,
  };
}

function resolveBySessionId(
  db: Db,
  agentSessionId: string,
  userId: string,
  orgId: string,
  timing?: ApiDispatchTimingCollector,
): Computed<Promise<ResolvedCompose | CreateRunErrorResult>> {
  return computed(async (): Promise<ResolvedCompose | CreateRunErrorResult> => {
    const [snapshot] = await measureApiDispatchTiming(
      timing,
      "api_dispatch_resolve_compose_lookup_session_snapshot",
      "nested",
      async () => {
        return await db
          .select({
            session: {
              id: agentSessions.id,
              storageMounts: agentSessions.storageMounts,
            },
            compose: {
              id: agentComposes.id,
              name: agentComposes.name,
              orgId: agentComposes.orgId,
              userId: agentComposes.userId,
              headVersionId: agentComposes.headVersionId,
            },
            version: {
              id: agentComposeVersions.id,
              content: agentComposeVersions.content,
            },
            conversation: {
              id: conversations.id,
              runId: conversations.runId,
              cliAgentSessionId: conversations.cliAgentSessionId,
              cliAgentSessionHistory: conversations.cliAgentSessionHistory,
              cliAgentSessionHistoryHash:
                conversations.cliAgentSessionHistoryHash,
            },
            historyBlob: {
              hash: blobs.hash,
              encoding: blobs.encoding,
            },
            previousRun: {
              id: agentRuns.id,
              vars: agentRuns.vars,
            },
          })
          .from(agentSessions)
          .leftJoin(
            agentComposes,
            eq(agentSessions.agentComposeId, agentComposes.id),
          )
          .leftJoin(
            agentComposeVersions,
            eq(agentComposeVersions.id, agentComposes.headVersionId),
          )
          .leftJoin(
            conversations,
            eq(agentSessions.conversationId, conversations.id),
          )
          .leftJoin(
            blobs,
            eq(conversations.cliAgentSessionHistoryHash, blobs.hash),
          )
          .leftJoin(agentRuns, eq(conversations.runId, agentRuns.id))
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

    if (!snapshot) {
      return notFound("Agent session not found");
    }
    if (!snapshot.compose) {
      return notFound("Agent compose not found");
    }
    if (!snapshot.compose.headVersionId || !snapshot.version) {
      return badRequestMessage(
        "Agent compose has no versions. Run 'vm0 build' first.",
      );
    }

    const conversation = snapshot.conversation;
    const resumeSession = conversation
      ? await measureApiDispatchTiming(
          timing,
          "api_dispatch_resolve_compose_resolve_session_history",
          "nested",
          (): StoredExecutionContext["resumeSession"] | undefined => {
            return resumeSessionFromSnapshot({
              ...conversation,
              sessionHistoryBlobEncoding:
                snapshot.historyBlob?.encoding ?? null,
            });
          },
        )
      : undefined;

    return {
      agentComposeVersionId: snapshot.version.id,
      composeId: snapshot.compose.id,
      composeUserId: snapshot.compose.userId,
      agentName: snapshot.compose.name || undefined,
      orgId: snapshot.compose.orgId,
      content: snapshot.version.content as AgentComposeContent,
      ...resolvedSessionStorage(snapshot.session),
      vars:
        (snapshot.previousRun?.vars as Record<string, string> | null) ??
        undefined,
      agentSessionId: snapshot.session.id,
      continuedFromAgentSessionId: snapshot.session.id,
      resumeSession,
    };
  });
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
          "Missing agentComposeId or agentComposeVersionId. Provide composeId, agentComposeVersionId, or sessionId.",
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

function prepareLaunchRunIdentity(args: {
  readonly resolved: ResolvedCompose;
}): LaunchRunIdentity {
  return {
    runId: randomUUID(),
    sessionId: args.resolved.agentSessionId ?? randomUUID(),
    shouldCreateSession: !args.resolved.agentSessionId,
  };
}

function runRecordFromLaunchIdentity(
  identity: LaunchRunIdentity,
  status: RunRecord["status"],
  createdAt: Date,
): RunRecord {
  return {
    id: identity.runId,
    createdAt,
    sessionId: identity.sessionId,
    shouldCreateSession: identity.shouldCreateSession,
    status,
  };
}

function runFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Run failed";
}

async function prepareRunCallbackRows(args: {
  readonly runId: string;
  readonly callbacks: readonly RunCallback[] | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<readonly AgentRunCallbackInsert[]> {
  const callbacks = args.callbacks ?? [];
  const internalCallbackCount = callbacks.filter((callback) => {
    return "internalKind" in callback;
  }).length;
  return await args.timing.measure(
    "api_dispatch_prepare_run_callbacks",
    "nested",
    async () => {
      return await Promise.all(
        callbacks.map(async (callback): Promise<AgentRunCallbackInsert> => {
          if ("internalKind" in callback) {
            return {
              runId: args.runId,
              url: null,
              internalKind: callback.internalKind,
              encryptedSecret: null,
              payload: callback.payload,
            };
          }
          return {
            runId: args.runId,
            url: callback.url,
            internalKind: null,
            encryptedSecret: await encryptPersistentSecretValue(
              callback.secret,
              args.featureSwitchContext,
            ),
            payload: callback.payload,
          };
        }),
      );
    },
    {
      run_callback_internal_count_bucket: countBucket(internalCallbackCount),
      run_callback_http_count_bucket: countBucket(
        callbacks.length - internalCallbackCount,
      ),
    },
  );
}

interface LaunchRunRowsArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly identity: LaunchRunIdentity;
  readonly status: LaunchRunStatus;
  readonly resolved: ResolvedCompose;
  readonly body: CreateRunBody;
  readonly runStorageMounts: readonly PersistedStorageMount[] | undefined;
  readonly sessionStorageMounts: readonly PersistedStorageMount[] | undefined;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly zeroRunModelPin: ZeroRunModelPin | undefined;
  readonly callbackRows: readonly AgentRunCallbackInsert[];
  readonly chatThreadId: string | undefined;
  readonly zeroRunMetadata: ZeroRunMetadata | undefined;
  readonly apiStartTime: number;
  readonly runnerGroup: string | undefined;
  readonly error: string | undefined;
}

function launchSessionValues(
  args: LaunchRunRowsArgs,
): typeof agentSessions.$inferInsert {
  return {
    id: args.identity.sessionId,
    userId: args.userId,
    orgId: args.orgId,
    agentComposeId: args.resolved.composeId,
    storageMounts: args.sessionStorageMounts
      ? [...args.sessionStorageMounts]
      : null,
    conversationId: null,
  };
}

function launchRunValues(
  args: LaunchRunRowsArgs,
  createdAt: Date,
): typeof agentRuns.$inferInsert {
  return {
    id: args.identity.runId,
    createdAt,
    userId: args.userId,
    orgId: args.orgId,
    agentComposeVersionId: args.resolved.agentComposeVersionId,
    status: args.status,
    prompt: args.body.prompt,
    appendSystemPrompt: args.body.appendSystemPrompt ?? null,
    vars: args.body.vars ?? null,
    secretNames: args.body.secrets ? Object.keys(args.body.secrets) : null,
    storageMounts: args.runStorageMounts ? [...args.runStorageMounts] : null,
    continuedFromSessionId: args.resolved.continuedFromAgentSessionId ?? null,
    sessionId: args.identity.sessionId,
    lastHeartbeatAt: createdAt,
    runnerGroup: args.runnerGroup ?? null,
    completedAt: args.status === "failed" ? createdAt : null,
    error: args.error ?? null,
  };
}

function launchZeroRunValues(
  args: LaunchRunRowsArgs,
): typeof zeroRuns.$inferInsert {
  const metadata: ZeroRunMetadata = args.zeroRunMetadata ?? {};
  return {
    id: args.identity.runId,
    triggerSource: args.body.triggerSource,
    workflowAutomationId: metadata.workflowAutomationId ?? null,
    triggerBrief: metadata.triggerBrief ?? null,
    runGroupId: metadata.goalId ?? null,
    goalId: metadata.goalId ?? null,
    ...(metadata.autonomyBudget === undefined
      ? {}
      : { autonomyBudget: metadata.autonomyBudget }),
    ...(args.zeroRunModelPin ?? zeroRunModelProviderValues(args.modelProvider)),
    ...(metadata.codexServiceTier === undefined
      ? {}
      : { codexServiceTier: metadata.codexServiceTier }),
    chatThreadId: args.chatThreadId ?? null,
    apiStartedAt: args.status === "queued" ? null : new Date(args.apiStartTime),
  };
}

async function insertLaunchRunRows(
  tx: Db,
  args: LaunchRunRowsArgs,
): Promise<{ readonly createdAt: Date }> {
  if (args.identity.shouldCreateSession) {
    await tx.insert(agentSessions).values(launchSessionValues(args));
  }

  const createdAt = nowDate();
  await tx.insert(agentRuns).values(launchRunValues(args, createdAt));
  const zeroRunValues = launchZeroRunValues(args);
  if (zeroRunValues.codexServiceTier === undefined) {
    await tx.insert(zeroRunsBeforeCodexServiceTier).values(zeroRunValues);
  } else {
    await tx.insert(zeroRuns).values(zeroRunValues);
  }

  if (args.callbackRows.length > 0) {
    await tx.insert(agentRunCallbacks).values([...args.callbackRows]);
  }

  return { createdAt };
}

function storedConnectorRuntimeTargets(args: {
  readonly permissionManifest: PermissionManifest | undefined;
  readonly customTargets: readonly ConnectorRuntimeTargetRegistration[];
}): ConnectorRuntimeTargetRegistration[] {
  const builtinTargets = Object.keys(
    args.permissionManifest?.connectorPermissionBaseline?.connectors ?? {},
  )
    .sort()
    .map((connectorSlug) => {
      return {
        kind: "builtin" as const,
        connectorSlug: connectorSlugSchema.parse(connectorSlug),
      };
    });
  return [...builtinTargets, ...args.customTargets];
}

async function buildStoredExecutionContextDraft(args: {
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
  readonly modelUsageProvider: SupportedRunModel | undefined;
  readonly apiStartTime: number;
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly extraEnvironment: Record<string, string> | undefined;
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<BuiltStoredExecutionContextDraft> {
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
  const environment = {
    ...expandEnvironment({
      content: args.resolved.content,
      vars: args.body.vars,
      secrets: executionSecrets.secrets,
      additionalEnvironment: args.modelProvider?.environment,
      environmentSecretPlaceholders: permissions?.environmentSecretPlaceholders,
      storedConnectorEnvironment: args.connectorContext.storedEnvironment,
      connectorVars: args.connectorContext.vars,
    }),
    ...args.extraEnvironment,
    CLI_PKG_URL: env("CLI_PKG_URL"),
  };
  const environmentKeyByValue = new Map<string, string>();
  for (const [key, value] of Object.entries(environment)) {
    if (!environmentKeyByValue.has(value)) {
      environmentKeyByValue.set(value, key);
    }
  }
  const secretValueEnvironmentKeys = executionSecrets.secrets
    ? secretValues.flatMap((value) => {
        const key = environmentKeyByValue.get(value);
        return key === undefined ? [] : [key];
      })
    : null;
  const connectorRuntimeTargets = storedConnectorRuntimeTargets({
    permissionManifest: permissions,
    customTargets: args.customConnectorContext.targets,
  });

  return {
    context: {
      environment,
      secretValueEnvironmentKeys,
      vars: args.connectorContext.vars ?? null,
      resumeSession: args.resolved.resumeSession ?? null,
      encryptedSecrets: await encryptPersistentSecretsMap(
        executionSecrets.secrets ?? null,
        args.featureSwitchContext,
      ),
      secretConnectorMap: executionSecrets.secretConnectorMap,
      secretConnectorMetadataMap: executionSecrets.secretConnectorMetadataMap,
      cliAgentType: args.framework,
      realAgentInPreview: args.body.realAgentInPreview || undefined,
      captureNetworkBodies: args.body.captureNetworkBodies || undefined,
      apiStartTime: args.apiStartTime,
      userTimezone: args.userTimezone,
      firewalls: permissions?.firewalls,
      networkPolicies: permissions?.networkPolicies,
      connectorRuntimeTargets,
      connectorPermissionBaseline: permissions?.connectorPermissionBaseline,
      disallowedTools: args.body.disallowedTools,
      tools: args.body.tools,
      settings: args.body.settings,
      featureFlags: getAllFeatureStates(args.featureSwitchContext),
      billableFirewalls: [...args.billableFirewalls],
      modelUsageProvider: args.modelUsageProvider,
      codexRuntimeConfig: args.modelProvider?.codexRuntimeConfig ?? null,
    },
    secretNames,
    secretValues,
  };
}

async function resolveBuiltStoredExecutionContext(
  preparedStoragePromise: Promise<PreparedAgentRunStorage>,
  builtContextDraftPromise: Promise<BuiltStoredExecutionContextDraft>,
): Promise<BuiltStoredExecutionContext> {
  const [preparedStorageResult, builtContextDraftResult] =
    await Promise.allSettled([
      preparedStoragePromise,
      builtContextDraftPromise,
    ]);
  if (preparedStorageResult.status === "rejected") {
    throw preparedStorageResult.reason;
  }
  if (builtContextDraftResult.status === "rejected") {
    throw builtContextDraftResult.reason;
  }
  return {
    ...builtContextDraftResult.value,
    persistedStorageMounts: [
      ...preparedStorageResult.value.persistedStorageMounts,
    ],
    runContextStorage: preparedStorageResult.value.runContextStorage,
    context: {
      ...builtContextDraftResult.value.context,
      storageMounts: [...preparedStorageResult.value.storageMounts],
    },
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

function buildRunContextSnapshot(args: {
  readonly runId: string;
  readonly userId: string;
  readonly body: CreateRunBody;
  readonly builtContext: BuiltStoredExecutionContext;
}): RunContextAxiomSnapshot {
  const storedContext = args.builtContext.context;
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
    cliAgentType: storedContext.cliAgentType,
    secretNames: [...args.builtContext.secretNames],
    environmentEntries: environmentRecordToEntries(sanitizedEnvironment),
    firewalls: firewallSnapshots(storedContext.firewalls),
    networkPolicyEntries: networkPoliciesRecordToEntries(
      storedContext.networkPolicies,
    ),
    volumes: args.builtContext.runContextStorage.volumes,
    artifact: args.builtContext.runContextStorage.artifact,
    featureFlagEntries: featureFlagsRecordToEntries(storedContext.featureFlags),
  };
  return snapshot;
}

function ingestRunContextSnapshot(snapshot: RunContextAxiomSnapshot): void {
  const result = safeSync(() => {
    return ingestToAxiom(getDatasetName("run-context"), [snapshot]);
  });
  if ("error" in result) {
    L.warn("Failed to ingest run context snapshot", {
      runId: snapshot.runId,
      error: result.error,
    });
  }
}

function recordQueuedRunEnqueueTelemetry(args: {
  readonly runId: string;
  readonly queueDepth: number;
  readonly timestamp: string;
}): void {
  const result = safeSync(() => {
    recordSandboxOperation({
      sandboxType: "runner",
      actionType: "enqueue_zero_run",
      durationMs: 0,
      success: true,
      runId: args.runId,
      timestamp: args.timestamp,
      dimensions: {
        queue_depth: args.queueDepth,
      },
    });
  });
  if ("error" in result) {
    L.warn("Failed to record queued run enqueue telemetry", {
      runId: args.runId,
      error: result.error,
    });
  }
}

function recordThreadSessionBindingTelemetry(args: {
  readonly binding: ThreadSessionBindingWrite;
  readonly runStatus: "pending" | "queued";
}): void {
  const result = safeSync(() => {
    recordSandboxOperation({
      sandboxType: "chat",
      actionType: "chat_thread_session_binding_persisted",
      durationMs: 0,
      success: true,
      runId: args.binding.agentSessionRunId,
      dimensions: {
        chat_thread_id: args.binding.chatThreadId,
        agent_session_id: args.binding.agentSessionId,
        agent_session_run_id: args.binding.agentSessionRunId,
        binding_action: args.binding.action,
        run_status: args.runStatus,
      },
    });
  });
  if ("error" in result) {
    L.warn("Failed to record chat thread session binding telemetry", {
      runId: args.binding.agentSessionRunId,
      error: result.error,
    });
  }
}

export function recordThreadSessionBindingRetryTelemetry(
  retry: ThreadSessionSnapshotStale,
): void {
  const result = safeSync(() => {
    recordSandboxOperation({
      sandboxType: "chat",
      actionType: "chat_thread_session_binding_retry",
      durationMs: 0,
      success: true,
      runId: retry.agentSessionRunId,
      dimensions: {
        chat_thread_id: retry.chatThreadId,
        agent_session_id: retry.agentSessionId,
        agent_session_run_id: retry.agentSessionRunId,
        binding_action: "retried",
        resolution_action: retry.resolutionAction,
        retry_reason: retry.reason,
      },
    });
  });
  if ("error" in result) {
    L.warn("Failed to record chat thread session binding retry telemetry", {
      runId: retry.agentSessionRunId,
      error: result.error,
    });
  }
}

async function publishQueueChangedSafely(args: {
  readonly orgId: string;
  readonly runId: string;
}): Promise<void> {
  await tapError(publishOrgSignal(args.orgId, "queue:changed"), (error) => {
    L.warn("Failed to publish queue changed signal after queued launch", {
      orgId: args.orgId,
      runId: args.runId,
      error,
    });
  });
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
      args.modelProvider?.secretConnectorMap,
      args.bodySecrets,
      args.customConnectorContext.reservedSecretAliases,
    ],
  });
  const filteredModelProviderMap = filterSecretConnectorMap({
    secretConnectorMap: args.modelProvider?.secretConnectorMap,
    overriddenSecrets: [
      args.bodySecrets,
      args.customConnectorContext.reservedSecretAliases,
    ],
  });
  const filteredConnectorMetadataMap = filterSecretConnectorMetadataMap({
    secretConnectorMetadataMap:
      args.connectorContext.secretConnectorMetadataMap,
    secretConnectorMap: filteredConnectorMap,
  });
  const filteredModelProviderMetadataMap = filterSecretConnectorMetadataMap({
    secretConnectorMetadataMap: args.modelProvider?.secretConnectorMetadataMap,
    secretConnectorMap: filteredModelProviderMap,
  });
  const secretConnectorMap =
    mergeRecords(filteredConnectorMap, filteredModelProviderMap) ?? null;
  const secretConnectorMetadataMap =
    mergeRecords(
      filteredConnectorMetadataMap,
      filteredModelProviderMetadataMap,
    ) ?? null;
  const secrets = mergeRecords(
    args.connectorContext.secrets,
    args.modelProvider?.secrets,
    args.bodySecrets,
  );
  // The merged map is the runtime `secrets.NAME` namespace consumed by firewall
  // auth and environment expansion. Stored connectors and model providers enter
  // this map under env binding aliases; raw DB storage names stay behind the
  // access metadata used during refresh/lookup.
  return {
    secrets: secrets ?? (secretConnectorMap ? {} : undefined),
    secretConnectorMap,
    secretConnectorMetadataMap,
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

function countBucket(count: number): (typeof COUNT_BUCKET_DIMENSIONS)[number] {
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
}): ApiDispatchTimingDimensions {
  return {
    connector_scope_source: args.scopeSource,
    ...(args.connectorCount !== undefined
      ? { stored_connector_count_bucket: countBucket(args.connectorCount) }
      : {}),
  };
}

function isModelProviderFirewallName(name: string): boolean {
  return name.startsWith("model-provider:");
}

function validateModelUsageProviderInvariant(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: SupportedRunModel | undefined;
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
): SupportedRunModel | undefined {
  if (!modelProvider?.selectedModel) {
    return undefined;
  }
  const canonicalModel = normalizeRunModelId(modelProvider.selectedModel);
  return isSupportedRunModel(canonicalModel) ? canonicalModel : undefined;
}

function sessionStorageMountsForPersistence(args: {
  readonly resolvedMounts: readonly PersistedStorageMount[];
  readonly artifacts: readonly ContextArtifact[];
}): readonly PersistedStorageMount[] {
  const artifactsByName = new Map<string, ContextArtifact>();
  for (const artifact of args.artifacts) {
    artifactsByName.set(artifact.name, artifact);
  }

  return args.resolvedMounts.flatMap((mount) => {
    if (!mount.writeback) {
      return [];
    }
    const artifact = artifactsByName.get(mount.name);
    if (!artifact || artifact.mountPath !== mount.mountPath) {
      throw new Error(
        `Resolved writeback Storage "${mount.name}" has no source declaration`,
      );
    }
    const {
      version: _resolvedVersion,
      missingRootPolicy: _resolvedMissingRootPolicy,
      ...mountBase
    } = mount;
    return [
      {
        ...mountBase,
        ...(artifact.version === undefined
          ? {}
          : { version: artifact.version }),
        ...(artifact.missingRootPolicy === undefined
          ? {}
          : { missingRootPolicy: artifact.missingRootPolicy }),
      },
    ];
  });
}

interface BuildRunnerJobPayloadInput {
  readonly run: Pick<RunRecord, "id" | "sessionId" | "shouldCreateSession">;
  readonly userId: string;
  readonly orgId: string;
  readonly resolved: ResolvedCompose;
  readonly body: CreateRunBody;
  readonly artifacts: readonly ContextArtifact[];
  readonly framework: SupportedFramework;
  readonly piEdge: PiEdgeModelConfig | undefined;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: SupportedRunModel | undefined;
  readonly apiStartTime: number;
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
  readonly includeZeroTokenSecret: boolean | undefined;
  readonly zeroTokenComputerUseHostId: string | undefined;
  readonly zeroTokenCloudBrowserEnabled: boolean | undefined;
  readonly imageRecognitionAvailable: boolean;
  readonly chatThreadId: string | undefined;
  readonly extraEnvironment: Record<string, string> | undefined;
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly timing?: ApiDispatchTimingCollector;
}

interface PreparedPiLaunchResources {
  readonly executionEnv: ExecutionEnv;
  readonly modelConfig: PiModelConfig;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly snapshot: RunSkillSnapshot;
}

function storedExecutionContextWithPiResources(
  context: StoredExecutionContext,
  resources: PreparedPiLaunchResources | undefined,
): StoredExecutionContext {
  if (resources === undefined) {
    return context;
  }
  return {
    ...context,
    piExecutionMode: "standby",
    runSkillSnapshot: resources.snapshot,
    piSystemPrompt: resources.systemPrompt,
    piModelConfig: resources.modelConfig,
  };
}

async function resolvePiAgentName(db: Db, composeId: string): Promise<string> {
  const [agent] = await db
    .select({
      displayName: zeroAgents.displayName,
      name: zeroAgents.name,
    })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, composeId))
    .limit(1);

  if (agent?.displayName?.trim()) {
    return agent.displayName;
  }
  if (agent?.name.trim()) {
    return agent.name;
  }
  return "Okou";
}

async function preparePiLaunchResources(args: {
  readonly get: <T>(computedValue: Computed<T>) => T;
  readonly db: Db;
  readonly runId: string;
  readonly body: CreateRunBody;
  readonly composeId: string;
  readonly piEdge: PiEdgeModelConfig | undefined;
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
}): Promise<PreparedPiLaunchResources | undefined> {
  if (args.piEdge === undefined) {
    return undefined;
  }
  const snapshot = buildRunSkillSnapshot({
    additionalVolumes: args.additionalVolumes,
    additionalVolumeSources: args.additionalVolumeSources,
    persistedStorageMounts: args.persistedStorageMounts,
  });
  const [resources, agentName] = await Promise.all([
    loadPiLaunchStorageResources(args.get, args.db, {
      snapshot,
      persistedStorageMounts: args.persistedStorageMounts,
    }),
    resolvePiAgentName(args.db, args.composeId),
  ]);
  const skills = await loadPiRunSkills(resources.env, snapshot);
  if (skills.diagnostics.length > 0) {
    L.warn("Pi run Skill catalog contains diagnostics", {
      runId: args.runId,
      diagnostics: skills.diagnostics,
    });
  }
  return {
    executionEnv: createPiNoopExecutionEnv(),
    modelConfig: piSandboxModelConfig(args.piEdge),
    prompt: formatPiUserPrompt(args.body.prompt, skills.skills),
    systemPrompt: renderPiSystemPrompt({
      agentName,
      appendSystemPrompt: args.body.appendSystemPrompt,
      agentInstructions: resources.agentInstructions,
      memory: resources.memory,
      skills: skills.skills,
    }),
    snapshot,
  };
}

function preparedRunnerGroup(content: AgentComposeContent): string {
  const group = runnerGroup(content) ?? optionalEnv("RUNNER_DEFAULT_GROUP");
  if (!group) {
    throw new Error("No executor configured: set RUNNER_DEFAULT_GROUP");
  }
  if (!isOfficialRunnerGroup(group)) {
    throw new Error("Only vm0/* runner groups are supported");
  }
  return group;
}

function preparedRunnerJobBody(
  args: BuildRunnerJobPayloadInput,
): CreateRunBody {
  if (!args.includeZeroTokenSecret) {
    return args.body;
  }
  return withZeroTokenSecret(
    args.body,
    generateZeroToken(
      args.userId,
      args.run.id,
      args.orgId,
      args.featureSwitchContext.overrides,
      {
        ...(args.zeroTokenComputerUseHostId
          ? { computerUseHostId: args.zeroTokenComputerUseHostId }
          : {}),
        cloudBrowserEnabled: args.zeroTokenCloudBrowserEnabled === true,
        imageRecognitionAvailable: args.imageRecognitionAvailable,
      },
    ),
  );
}

function piEdgeUsageConfig(
  args: BuildRunnerJobPayloadInput,
): PiEdgeUsageConfig | undefined {
  if (args.piEdge === undefined) {
    return undefined;
  }
  if (args.modelUsageProvider === undefined) {
    if (args.modelProvider?.type === "vm0") {
      throw new Error("Pi edge usage requires a canonical managed model");
    }
    return undefined;
  }
  return {
    model: args.modelUsageProvider,
    billable: args.modelProvider?.type === "vm0",
  };
}

function buildRunnerJobPayload(
  db: Db,
  args: BuildRunnerJobPayloadInput,
): Computed<Promise<PreparedRunnerLaunch>> {
  return computed(async (get): Promise<PreparedRunnerLaunch> => {
    const group = preparedRunnerGroup(args.resolved.content);
    const body = preparedRunnerJobBody(args);
    const storageManifestStats = args.timing
      ? new StorageManifestBuildStats()
      : undefined;
    const preparedStoragePromise = measureApiDispatchTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest",
      "nested",
      async () => {
        return await get(
          prepareAgentRunStorage({
            db,
            content: args.resolved.content,
            vars: body.vars,
            agentOrgId: args.resolved.orgId,
            runtimeOrgId: args.orgId,
            userId: args.userId,
            artifacts: args.artifacts,
            volumeVersionOverrides: body.volumeVersions,
            additionalVolumes: args.additionalVolumes,
            additionalVolumeSources: args.additionalVolumeSources,
            framework: args.framework,
            persistedStorageMounts: args.resolved.persistedStorageMounts,
            timing: args.timing,
            stats: storageManifestStats,
          }),
        );
      },
      () => {
        return storageManifestStats?.overallDimensions();
      },
    );
    const builtContextDraftPromise = measureApiDispatchTiming(
      args.timing,
      "api_dispatch_build_stored_execution_context",
      "nested",
      async () => {
        return await buildStoredExecutionContextDraft({
          ...args,
          body,
          runId: args.run.id,
        });
      },
    );
    const builtContext = await resolveBuiltStoredExecutionContext(
      preparedStoragePromise,
      builtContextDraftPromise,
    );
    const piResources = await preparePiLaunchResources({
      get,
      db,
      runId: args.run.id,
      body,
      composeId: args.resolved.composeId,
      piEdge: args.piEdge,
      additionalVolumes: args.additionalVolumes,
      additionalVolumeSources: args.additionalVolumeSources,
      persistedStorageMounts: builtContext.persistedStorageMounts,
    });
    const storedContext = storedExecutionContextWithPiResources(
      builtContext.context,
      piResources,
    );
    const piEdgeUsage = piEdgeUsageConfig(args);
    const piEdge =
      args.piEdge === undefined || piResources === undefined
        ? undefined
        : {
            model: args.piEdge,
            ...(piEdgeUsage === undefined ? {} : { usage: piEdgeUsage }),
            executionEnv: piResources.executionEnv,
            prompt: piResources.prompt,
            systemPrompt: piResources.systemPrompt,
            skillSnapshot: piResources.snapshot,
          };
    const runContextSnapshot = buildRunContextSnapshot({
      runId: args.run.id,
      userId: args.userId,
      body,
      builtContext: { ...builtContext, context: storedContext },
    });
    const cliAgentSessionId = storedContext.resumeSession?.sessionId ?? null;
    return {
      ...(piEdge === undefined ? {} : { piEdge }),
      runnerJobPayload: queuedRunnerJobPayload({
        runnerGroup: group,
        profile: runnerProfile(args.resolved.content),
        cliAgentSessionId,
        reuseKey: runnerReuseKey(args.chatThreadId),
        executionContext: storedContext,
        ...(piEdge === undefined
          ? {}
          : {
              piEdge: {
                model: piEdge.model,
                prompt: piEdge.prompt,
                ...(piEdge.usage === undefined ? {} : { usage: piEdge.usage }),
              },
            }),
      }),
      runContextSnapshot,
      runStorageMounts: builtContext.persistedStorageMounts,
      sessionStorageMounts: sessionStorageMountsForPersistence({
        resolvedMounts: builtContext.persistedStorageMounts,
        artifacts: args.artifacts,
      }),
    };
  });
}

function preparedLaunchRowsArgs(args: {
  readonly commit: CommitPreparedLaunchArgs;
  readonly status: Extract<LaunchRunStatus, "pending" | "queued">;
  readonly runnerGroup: string;
}): LaunchRunRowsArgs {
  return {
    userId: args.commit.createArgs.userId,
    orgId: args.commit.createArgs.orgId,
    identity: args.commit.identity,
    status: args.status,
    resolved: args.commit.context.resolved,
    body: args.commit.context.body,
    runStorageMounts: args.commit.launch.runStorageMounts,
    sessionStorageMounts: args.commit.launch.sessionStorageMounts,
    modelProvider: args.commit.context.modelProvider,
    zeroRunModelPin: args.commit.createArgs.zeroRunModelPin,
    callbackRows: args.commit.callbackRows,
    chatThreadId: args.commit.createArgs.chatThreadId,
    zeroRunMetadata: args.commit.createArgs.zeroRunMetadata,
    apiStartTime: args.commit.createArgs.apiStartTime,
    runnerGroup: args.runnerGroup,
    error: undefined,
  };
}

interface PersistAtomicLaunchRowsArgs {
  readonly tx: DbTransaction;
  readonly commit: CommitPreparedLaunchArgs;
  readonly status: Extract<LaunchRunStatus, "pending" | "queued">;
  readonly payload: RunnerJobPayload;
  readonly validatedThreadSession: ValidatedThreadSessionSnapshot | undefined;
}

type ReturnedIdCte = WithSubquery & { readonly id: SQLWrapper };

function returnedCteId(cte: ReturnedIdCte): SQL {
  // Child mutations read the returned key so their dependency is explicit;
  // data-modifying CTE declaration order alone does not order execution.
  return sql`(SELECT ${cte.id} FROM ${cte})`;
}

function nullableReturnedCteId(cte: ReturnedIdCte | undefined): SQL {
  return cte ? sql`(SELECT ${cte.id} FROM ${cte})` : sql`NULL`;
}

function appendLaunchCallbackCte(args: {
  readonly tx: DbTransaction;
  readonly ctes: WithSubquery[];
  readonly callbacks: readonly AgentRunCallbackInsert[];
  readonly insertedRun: ReturnedIdCte;
}): void {
  if (args.callbacks.length === 0) {
    return;
  }
  const insertedCallbacks = args.tx.$with("inserted_launch_callbacks").as(
    args.tx.insert(agentRunCallbacks).values(
      args.callbacks.map((callback) => {
        return { ...callback, runId: returnedCteId(args.insertedRun) };
      }),
    ),
  );
  args.ctes.push(insertedCallbacks);
}

function launchThreadBindingCte(args: {
  readonly tx: DbTransaction;
  readonly chatThreadId: string | undefined;
  readonly identity: LaunchRunIdentity;
  readonly insertedRun: ReturnedIdCte;
  readonly validatedThreadSession: ValidatedThreadSessionSnapshot | undefined;
}) {
  if (!args.chatThreadId || !args.validatedThreadSession) {
    return undefined;
  }
  if (args.validatedThreadSession.chatThreadId !== args.chatThreadId) {
    throw new Error("Validated chat thread does not match binding target");
  }
  return args.tx.$with("updated_launch_thread_binding").as(
    args.tx
      .update(chatThreads)
      .set({
        agentSessionId: args.identity.sessionId,
        agentSessionRunId: returnedCteId(args.insertedRun),
      })
      .where(eq(chatThreads.id, args.chatThreadId))
      .returning({ id: chatThreads.id }),
  );
}

function buildAtomicLaunchCteContext(args: PersistAtomicLaunchRowsArgs) {
  const rowsArgs = preparedLaunchRowsArgs({
    commit: args.commit,
    status: args.status,
    runnerGroup: args.payload.runnerGroup,
  });
  const createdAt = nowDate();
  const ctes: WithSubquery[] = [];
  const insertedSession = rowsArgs.identity.shouldCreateSession
    ? args.tx
        .$with("inserted_launch_session")
        .as(
          args.tx
            .insert(agentSessions)
            .values(launchSessionValues(rowsArgs))
            .returning({ id: agentSessions.id }),
        )
    : undefined;
  if (insertedSession) {
    ctes.push(insertedSession);
  }

  const insertedRun = args.tx.$with("inserted_launch_run").as(
    args.tx
      .insert(agentRuns)
      .values({
        ...launchRunValues(rowsArgs, createdAt),
        sessionId: insertedSession
          ? returnedCteId(insertedSession)
          : rowsArgs.identity.sessionId,
      })
      .returning({ id: agentRuns.id, createdAt: agentRuns.createdAt }),
  );
  ctes.push(insertedRun);

  const zeroRunValues = {
    ...launchZeroRunValues(rowsArgs),
    id: returnedCteId(insertedRun),
  };
  const insertedZeroRun =
    zeroRunValues.codexServiceTier === undefined
      ? args.tx
          .$with("inserted_launch_zero_run")
          .as(
            args.tx
              .insert(zeroRunsBeforeCodexServiceTier)
              .values(zeroRunValues),
          )
      : args.tx
          .$with("inserted_launch_zero_run")
          .as(args.tx.insert(zeroRuns).values(zeroRunValues));
  ctes.push(insertedZeroRun);

  appendLaunchCallbackCte({
    tx: args.tx,
    ctes,
    callbacks: rowsArgs.callbackRows,
    insertedRun,
  });
  const chatThreadId = args.commit.createArgs.chatThreadId;
  const updatedThread = launchThreadBindingCte({
    tx: args.tx,
    chatThreadId,
    identity: rowsArgs.identity,
    insertedRun,
    validatedThreadSession: args.validatedThreadSession,
  });
  return { rowsArgs, createdAt, ctes, insertedRun, updatedThread };
}

type AtomicLaunchCteContext = ReturnType<typeof buildAtomicLaunchCteContext>;

function atomicThreadSessionBinding(args: {
  readonly context: AtomicLaunchCteContext;
  readonly commit: CommitPreparedLaunchArgs;
  readonly validatedThreadSession: ValidatedThreadSessionSnapshot | undefined;
  readonly boundThreadId: string | null;
  readonly runId: string;
}): ThreadSessionBindingWrite | undefined {
  if (!args.boundThreadId) {
    return undefined;
  }
  if (!args.validatedThreadSession) {
    throw new Error("Atomic thread binding requires a validated snapshot");
  }
  return {
    chatThreadId: args.boundThreadId,
    agentSessionId: args.context.rowsArgs.identity.sessionId,
    agentSessionRunId: args.runId,
    action: threadSessionBindingAction({
      identity: args.context.rowsArgs.identity,
      previousAgentSessionId: args.validatedThreadSession.agentSessionId,
      resolution: args.commit.createArgs.threadSessionResolution,
    }),
  };
}

async function persistPendingAtomicLaunch(
  args: PersistAtomicLaunchRowsArgs,
  context: AtomicLaunchCteContext,
): Promise<Extract<PersistedAtomicLaunchRows, { readonly kind: "pending" }>> {
  const timestamps = runnerJobQueueTimestamps();
  const insertedQueue = args.tx.$with("inserted_launch_runner_job").as(
    args.tx
      .insert(runnerJobQueue)
      .values({
        runId: returnedCteId(context.insertedRun),
        runnerGroup: args.payload.runnerGroup,
        profile: args.payload.profile,
        cliAgentSessionId: args.payload.cliAgentSessionId,
        reuseKey: args.payload.reuseKey,
        executionContext: args.payload.executionContext,
        ...timestamps,
      })
      .returning({
        runId: runnerJobQueue.runId,
        createdAt: runnerJobQueue.createdAt,
      }),
  );
  const ctes = [...context.ctes, insertedQueue];
  if (context.updatedThread) {
    ctes.push(context.updatedThread);
  }
  const [row] = await args.tx
    .with(...ctes)
    .select({
      runId: context.insertedRun.id,
      createdAt: context.insertedRun.createdAt,
      runnerJobCreatedAt: insertedQueue.createdAt,
      boundThreadId: nullableReturnedCteId(context.updatedThread).mapWith(
        nullableDriverValueDecoder(pgTextDecoder),
      ),
    })
    .from(context.insertedRun)
    .innerJoin(insertedQueue, eq(insertedQueue.runId, context.insertedRun.id));
  if (!row || (context.updatedThread && !row.boundThreadId)) {
    throw new Error("Atomic pending launch persistence returned no row");
  }
  return {
    kind: "pending",
    run: runRecordFromLaunchIdentity(
      context.rowsArgs.identity,
      "pending",
      row.createdAt,
    ),
    runnerJobCreatedAt: row.runnerJobCreatedAt,
    threadSessionBinding: atomicThreadSessionBinding({
      context,
      commit: args.commit,
      validatedThreadSession: args.validatedThreadSession,
      boundThreadId: row.boundThreadId,
      runId: row.runId,
    }),
  };
}

async function persistQueuedAtomicLaunch(
  args: PersistAtomicLaunchRowsArgs,
  context: AtomicLaunchCteContext,
): Promise<Extract<PersistedAtomicLaunchRows, { readonly kind: "queued" }>> {
  if (!args.commit.encryptedQueuedParams) {
    throw new Error("Missing encrypted queued runner job payload");
  }
  const insertedQueue = args.tx.$with("inserted_launch_run_queue").as(
    args.tx
      .insert(agentRunQueue)
      .values({
        runId: returnedCteId(context.insertedRun),
        userId: args.commit.createArgs.userId,
        orgId: args.commit.createArgs.orgId,
        encryptedParams: args.commit.encryptedQueuedParams,
        createdAt: context.createdAt,
        expiresAt: sql`now() + interval '2 hours'`,
      })
      .returning({ runId: agentRunQueue.runId }),
  );
  const ctes = [...context.ctes, insertedQueue];
  if (context.updatedThread) {
    ctes.push(context.updatedThread);
  }
  const visibleQueueDepth = args.tx
    .select({ depth: count().as("depth") })
    .from(agentRunQueue)
    .where(eq(agentRunQueue.orgId, args.commit.createArgs.orgId))
    .as("visible_launch_queue_depth");
  const [row] = await args.tx
    .with(...ctes)
    .select({
      runId: context.insertedRun.id,
      createdAt: context.insertedRun.createdAt,
      queueDepth: sql`(${visibleQueueDepth.depth} + 1)`.mapWith(
        pgInt8ToBigIntDecoder,
      ),
      boundThreadId: nullableReturnedCteId(context.updatedThread).mapWith(
        nullableDriverValueDecoder(pgTextDecoder),
      ),
    })
    .from(context.insertedRun)
    .innerJoin(insertedQueue, eq(insertedQueue.runId, context.insertedRun.id))
    .crossJoin(visibleQueueDepth);
  if (!row || (context.updatedThread && !row.boundThreadId)) {
    throw new Error("Atomic queued launch persistence returned no row");
  }
  return {
    kind: "queued",
    run: runRecordFromLaunchIdentity(
      context.rowsArgs.identity,
      "queued",
      row.createdAt,
    ),
    queueDepth: Number(row.queueDepth),
    telemetryTimestamp: nowDate().toISOString(),
    threadSessionBinding: atomicThreadSessionBinding({
      context,
      commit: args.commit,
      validatedThreadSession: args.validatedThreadSession,
      boundThreadId: row.boundThreadId,
      runId: row.runId,
    }),
  };
}

async function persistAtomicLaunchRows(
  args: PersistAtomicLaunchRowsArgs,
): Promise<PersistedAtomicLaunchRows> {
  const context = buildAtomicLaunchCteContext(args);
  const persisted = await args.commit.timing.measure(
    "api_dispatch_persist_atomic_launch",
    "nested",
    async () => {
      return args.status === "pending"
        ? await persistPendingAtomicLaunch(args, context)
        : await persistQueuedAtomicLaunch(args, context);
    },
  );

  const chatThreadId = args.commit.createArgs.chatThreadId;
  if (chatThreadId && !args.validatedThreadSession) {
    const threadSessionBinding = await persistUnvalidatedThreadSessionBinding(
      args.tx,
      {
        chatThreadId,
        identity: context.rowsArgs.identity,
        resolution: args.commit.createArgs.threadSessionResolution,
        timing: args.commit.timing,
      },
    );
    return { ...persisted, threadSessionBinding };
  }
  return persisted;
}

async function checkRunConcurrencyPreflight(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<CreateRunErrorResult | null> {
  return await args.db.transaction(async (tx) => {
    await args.timing.measure(
      "api_dispatch_concurrency_preflight_lock_wait",
      "nested",
      async () => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${args.orgId}))`,
        );
      },
    );
    return await args.timing.measure(
      "api_dispatch_concurrency_preflight_check",
      "nested",
      async () => {
        return await checkRunConcurrencyLimit(tx, args.orgId);
      },
    );
  });
}

async function resolveQueueFirstAdmissionForLaunch(args: {
  readonly tx: DbTransaction;
  readonly createArgs: CreateAgentRunArgs;
  readonly sessionSnapshotState: QueueFirstRunSessionSnapshotState;
  readonly threadAlreadyLocked?: true;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<QueueFirstRunAdmission | undefined> {
  const association = args.createArgs.queueFirstAssociation;
  if (!association) {
    return undefined;
  }
  if (association.threadId !== args.createArgs.chatThreadId) {
    throw new Error("Queue-first association must match the run chat thread");
  }
  return await resolveQueueFirstRunAdmission(args.tx, {
    admissionTime:
      association.kind === "user_message"
        ? association.admissionTime
        : args.createArgs.apiStartTime,
    sessionSnapshotState: args.sessionSnapshotState,
    threadId: association.threadId,
    timing: args.timing,
    ...(args.threadAlreadyLocked ? { threadAlreadyLocked: true } : {}),
  });
}

async function lockQueueFirstRunSourceForLaunch(args: {
  readonly tx: DbTransaction;
  readonly createArgs: CreateAgentRunArgs;
}): Promise<void> {
  const association = args.createArgs.queueFirstAssociation;
  if (association?.kind === "goal_input") {
    await lockGoalQueueFirstRunSource(args.tx, association);
  }
}

async function claimQueueFirstAssociationForLaunch(args: {
  readonly tx: DbTransaction;
  readonly admission: QueueFirstRunAdmission | undefined;
  readonly createArgs: CreateAgentRunArgs;
  readonly identity: LaunchRunIdentity;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<QueueFirstRunClaimResult | undefined> {
  const association = args.createArgs.queueFirstAssociation;
  if (!association) {
    return undefined;
  }
  if (!args.admission) {
    throw new Error("Queue-first claim requires resolved thread admission");
  }
  if (!args.createArgs.zeroRunModelPin) {
    throw new Error("Queue-first claim requires a run model pin");
  }
  return await claimQueueFirstRunAssociation(args.tx, {
    ...association,
    admission: args.admission,
    runId: args.identity.runId,
    selectedModel: args.createArgs.zeroRunModelPin.selectedModel,
    timing: args.timing,
  });
}

async function commitFailedLaunch(args: {
  readonly db: Db;
  readonly createArgs: CreateAgentRunArgs;
  readonly context: PreparedRunContext;
  readonly identity: LaunchRunIdentity;
  readonly callbackRows: readonly AgentRunCallbackInsert[];
  readonly error: unknown;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<CreateRunSuccessResult | QueueFirstRunClaimLost> {
  const message = runFailureMessage(args.error);
  const committed = await args.db.transaction(
    async (tx): Promise<FailedLaunchCommitResult> => {
      await lockQueueFirstRunSourceForLaunch({
        tx,
        createArgs: args.createArgs,
      });
      const queueFirstAdmission = await resolveQueueFirstAdmissionForLaunch({
        tx,
        createArgs: args.createArgs,
        sessionSnapshotState: "unvalidated",
        timing: args.timing,
      });
      const queueFirstClaim = await claimQueueFirstAssociationForLaunch({
        tx,
        admission: queueFirstAdmission,
        createArgs: args.createArgs,
        identity: args.identity,
        timing: args.timing,
      });
      if (queueFirstClaim?.kind === "lost") {
        return { kind: "queue-first-claim-lost" };
      }
      const { createdAt } = await insertLaunchRunRows(tx, {
        userId: args.createArgs.userId,
        orgId: args.createArgs.orgId,
        identity: args.identity,
        status: "failed",
        resolved: args.context.resolved,
        body: args.context.body,
        runStorageMounts: undefined,
        sessionStorageMounts: undefined,
        modelProvider: args.context.modelProvider,
        zeroRunModelPin: args.createArgs.zeroRunModelPin,
        callbackRows: args.callbackRows,
        chatThreadId: args.createArgs.chatThreadId,
        zeroRunMetadata: args.createArgs.zeroRunMetadata,
        apiStartTime: args.createArgs.apiStartTime,
        runnerGroup: undefined,
        error: message,
      });
      if (queueFirstClaim) {
        await recordQueueFirstFailedRun(tx, {
          claim: queueFirstClaim,
          runId: args.identity.runId,
        });
      }
      return {
        kind: "failed",
        createdAt,
        queueFirstClaim,
      };
    },
  );

  if (committed.kind === "queue-first-claim-lost") {
    return committed;
  }

  if (args.createArgs.chatThreadId) {
    recordFirstAssistantEventEligibility({
      runId: args.identity.runId,
      apiStartedAt: args.createArgs.apiStartTime,
    });
  }

  await publishRunChangedForUserSafely(
    args.createArgs.userId,
    args.identity.runId,
    {
      status: "failed",
    },
  );
  if (args.createArgs.dispatchFailedCallbacks) {
    await tapError(
      args.createArgs.dispatchFailedCallbacks(
        args.db,
        args.identity.runId,
        message,
      ),
      (error) => {
        L.error("Failed to dispatch failed-run callbacks", {
          runId: args.identity.runId,
          error,
        });
      },
    );
  }
  const response = failedRunResponse(
    runRecordFromLaunchIdentity(args.identity, "pending", committed.createdAt),
    args.error,
  );
  return committed.queueFirstClaim
    ? { ...response, queueFirstClaim: committed.queueFirstClaim }
    : response;
}

async function activatePreparedLaunchUsageAllowance(args: {
  readonly tx: DbTransaction;
  readonly commit: CommitPreparedLaunchArgs;
  readonly run: RunRecord;
}): Promise<void> {
  if (args.commit.context.modelProvider?.type === "vm0") {
    await args.commit.timing.measure(
      "api_dispatch_activate_usage_allowance_windows",
      "nested",
      async () => {
        await activateUsageAllowanceWindowsForRun(args.tx, {
          orgId: args.commit.createArgs.orgId,
          runId: args.run.id,
          runCreatedAt: args.run.createdAt,
        });
      },
    );
  }
}

function threadSessionBindingAction(args: {
  readonly identity: LaunchRunIdentity;
  readonly previousAgentSessionId: string | null;
  readonly resolution: ChatThreadSessionResolution | undefined;
}): ThreadSessionBindingAction {
  return (
    args.resolution?.action ??
    (args.previousAgentSessionId === null
      ? "initialized"
      : args.previousAgentSessionId === args.identity.sessionId
        ? "reused"
        : "rotated")
  );
}

async function persistUnvalidatedThreadSessionBinding(
  tx: DbTransaction,
  args: {
    readonly chatThreadId: string;
    readonly identity: LaunchRunIdentity;
    readonly resolution: ChatThreadSessionResolution | undefined;
    readonly timing: ApiDispatchTimingCollector;
  },
): Promise<ThreadSessionBindingWrite> {
  const chatThreadId = args.chatThreadId;
  const [thread] = await args.timing.measure(
    "api_dispatch_load_thread_session_binding",
    "nested",
    async () => {
      return await tx
        .select({ agentSessionId: chatThreads.agentSessionId })
        .from(chatThreads)
        .where(eq(chatThreads.id, chatThreadId))
        .for("update")
        .limit(1);
    },
  );
  if (!thread) {
    throw new Error("Chat thread not found while persisting session binding");
  }

  const action = threadSessionBindingAction({
    identity: args.identity,
    previousAgentSessionId: thread.agentSessionId,
    resolution: args.resolution,
  });
  const [updated] = await args.timing.measure(
    "api_dispatch_update_thread_session_binding",
    "nested",
    async () => {
      return await tx
        .update(chatThreads)
        .set({
          agentSessionId: args.identity.sessionId,
          agentSessionRunId: args.identity.runId,
        })
        .where(eq(chatThreads.id, chatThreadId))
        .returning({ id: chatThreads.id });
    },
  );
  if (!updated) {
    throw new Error("Failed to persist chat thread session binding");
  }

  return {
    chatThreadId: updated.id,
    agentSessionId: args.identity.sessionId,
    agentSessionRunId: args.identity.runId,
    action,
  };
}

function threadSessionSnapshotStale(args: {
  readonly createArgs: CreateAgentRunArgs;
  readonly identity: LaunchRunIdentity;
  readonly reason: ThreadSessionSnapshotStale["reason"];
}): ThreadSessionSnapshotStale {
  const resolution = args.createArgs.threadSessionResolution;
  const chatThreadId = args.createArgs.chatThreadId;
  if (!resolution || !chatThreadId) {
    throw new Error("Missing chat thread session snapshot");
  }
  return {
    kind: "thread-session-snapshot-stale",
    chatThreadId,
    agentSessionId: args.identity.sessionId,
    agentSessionRunId: args.identity.runId,
    resolutionAction: resolution.action,
    reason: args.reason,
  };
}

async function validateThreadSessionSnapshot(
  tx: DbTransaction,
  args: {
    readonly createArgs: CreateAgentRunArgs;
    readonly identity: LaunchRunIdentity;
    readonly timing: ApiDispatchTimingCollector;
  },
): Promise<
  ThreadSessionSnapshotStale | ValidatedThreadSessionSnapshot | undefined
> {
  const resolution = args.createArgs.threadSessionResolution;
  const chatThreadId = args.createArgs.chatThreadId;
  if (!resolution || !chatThreadId) {
    return undefined;
  }

  const [thread] = await args.timing.measure(
    "api_dispatch_validate_thread_session_snapshot_thread",
    "nested",
    async () => {
      return await tx
        .select({
          agentSessionId: chatThreads.agentSessionId,
          agentSessionRunId: chatThreads.agentSessionRunId,
        })
        .from(chatThreads)
        .where(eq(chatThreads.id, chatThreadId))
        .for("update")
        .limit(1);
    },
  );
  if (!thread) {
    throw new Error("Chat thread not found while validating session snapshot");
  }
  if (
    thread.agentSessionId !== resolution.expected.agentSessionId ||
    thread.agentSessionRunId !== resolution.expected.agentSessionRunId
  ) {
    return threadSessionSnapshotStale({
      createArgs: args.createArgs,
      identity: args.identity,
      reason: "binding_changed",
    });
  }

  const expectedSessionId = resolution.expected.sessionId;
  if (expectedSessionId === null) {
    return {
      kind: "validated-thread-session-snapshot",
      chatThreadId,
      agentSessionId: thread.agentSessionId,
    };
  }
  const [session] = await args.timing.measure(
    "api_dispatch_validate_thread_session_snapshot_session",
    "nested",
    async () => {
      return await tx
        .select({ conversationId: agentSessions.conversationId })
        .from(agentSessions)
        .where(eq(agentSessions.id, expectedSessionId))
        .for("update")
        .limit(1);
    },
  );
  if (
    !session ||
    session.conversationId !== resolution.expected.conversationId
  ) {
    return threadSessionSnapshotStale({
      createArgs: args.createArgs,
      identity: args.identity,
      reason: "session_changed",
    });
  }
  return {
    kind: "validated-thread-session-snapshot",
    chatThreadId,
    agentSessionId: thread.agentSessionId,
  };
}

async function commitQueuedPreparedLaunch(
  tx: DbTransaction,
  args: CommitPreparedLaunchArgs,
  payload: RunnerJobPayload,
  queueFirstClaim: QueueFirstRunClaimed | undefined,
  validatedThreadSession: ValidatedThreadSessionSnapshot | undefined,
): Promise<Extract<AtomicLaunchCommitResult, { readonly kind: "queued" }>> {
  if (!args.encryptedQueuedParams) {
    throw new Error("Missing encrypted queued runner job payload");
  }

  const persisted = await persistAtomicLaunchRows({
    tx,
    commit: args,
    status: "queued",
    payload,
    validatedThreadSession,
  });
  if (persisted.kind !== "queued") {
    throw new Error("Queued launch persistence returned a pending result");
  }
  await activatePreparedLaunchUsageAllowance({
    tx,
    commit: args,
    run: persisted.run,
  });
  if (queueFirstClaim) {
    await recordQueueFirstClaimedRun(tx, {
      claim: queueFirstClaim,
      runId: persisted.run.id,
    });
  }
  return {
    ...persisted,
    runnerJobPayload: payload,
    runContextSnapshot: args.launch.runContextSnapshot,
    queueFirstClaim,
  };
}

async function commitPendingPreparedLaunch(
  tx: DbTransaction,
  args: CommitPreparedLaunchArgs,
  payload: RunnerJobPayload,
  queueFirstClaim: QueueFirstRunClaimed | undefined,
  validatedThreadSession: ValidatedThreadSessionSnapshot | undefined,
): Promise<Extract<AtomicLaunchCommitResult, { readonly kind: "pending" }>> {
  const persisted = await persistAtomicLaunchRows({
    tx,
    commit: args,
    status: "pending",
    payload,
    validatedThreadSession,
  });
  if (persisted.kind !== "pending") {
    throw new Error("Pending launch persistence returned a queued result");
  }
  await activatePreparedLaunchUsageAllowance({
    tx,
    commit: args,
    run: persisted.run,
  });
  if (queueFirstClaim) {
    await recordQueueFirstClaimedRun(tx, {
      claim: queueFirstClaim,
      runId: persisted.run.id,
    });
  }
  return {
    ...persisted,
    runnerJobPayload: payload,
    runContextSnapshot: args.launch.runContextSnapshot,
    queueFirstClaim,
  };
}

async function commitPreparedLaunchUnderLock(
  tx: DbTransaction,
  args: CommitPreparedLaunchArgs,
  payload: RunnerJobPayload,
): Promise<AtomicLaunchCommitResult | CreateRunErrorResult> {
  const threadSessionValidation = await validateThreadSessionSnapshot(tx, {
    createArgs: args.createArgs,
    identity: args.identity,
    timing: args.timing,
  });
  if (threadSessionValidation?.kind === "thread-session-snapshot-stale") {
    const queueFirstAdmission = await resolveQueueFirstAdmissionForLaunch({
      tx,
      createArgs: args.createArgs,
      sessionSnapshotState: threadSessionValidation.reason,
      threadAlreadyLocked: true,
      timing: args.timing,
    });
    if (!queueFirstAdmission || queueFirstAdmission.kind === "idle") {
      return threadSessionValidation;
    }
    const queueFirstClaim = await claimQueueFirstAssociationForLaunch({
      tx,
      admission: queueFirstAdmission,
      createArgs: args.createArgs,
      identity: args.identity,
      timing: args.timing,
    });
    if (queueFirstClaim?.kind !== "lost") {
      throw new Error("Blocked queue-first admission must lose its claim");
    }
    return { kind: "queue-first-claim-lost" };
  }
  const validatedThreadSession = threadSessionValidation;
  const concurrency = await args.timing.measure(
    "api_dispatch_check_concurrency_limit",
    "nested",
    async () => {
      return await checkRunConcurrencyLimit(tx, args.createArgs.orgId);
    },
  );

  if (concurrency) {
    if (!args.createArgs.queueOnConcurrencyLimit) {
      return concurrency;
    }
    if (!args.encryptedQueuedParams) {
      return { kind: "queue-payload-required" };
    }
    const queueFirstAdmission = await resolveQueueFirstAdmissionForLaunch({
      tx,
      createArgs: args.createArgs,
      sessionSnapshotState: validatedThreadSession ? "current" : "unvalidated",
      ...(validatedThreadSession ? { threadAlreadyLocked: true } : {}),
      timing: args.timing,
    });
    const queueFirstClaim = await claimQueueFirstAssociationForLaunch({
      tx,
      admission: queueFirstAdmission,
      createArgs: args.createArgs,
      identity: args.identity,
      timing: args.timing,
    });
    if (queueFirstClaim?.kind === "lost") {
      return { kind: "queue-first-claim-lost" };
    }
    return await commitQueuedPreparedLaunch(
      tx,
      args,
      payload,
      queueFirstClaim,
      validatedThreadSession,
    );
  }

  const queueFirstAdmission = await resolveQueueFirstAdmissionForLaunch({
    tx,
    createArgs: args.createArgs,
    sessionSnapshotState: validatedThreadSession ? "current" : "unvalidated",
    ...(validatedThreadSession ? { threadAlreadyLocked: true } : {}),
    timing: args.timing,
  });
  const queueFirstClaim = await claimQueueFirstAssociationForLaunch({
    tx,
    admission: queueFirstAdmission,
    createArgs: args.createArgs,
    identity: args.identity,
    timing: args.timing,
  });
  if (queueFirstClaim?.kind === "lost") {
    return { kind: "queue-first-claim-lost" };
  }
  return await commitPendingPreparedLaunch(
    tx,
    args,
    payload,
    queueFirstClaim,
    validatedThreadSession,
  );
}

async function commitPreparedLaunch(
  args: CommitPreparedLaunchArgs,
): Promise<AtomicLaunchCommitResult | CreateRunErrorResult> {
  const committed = await args.db.transaction(async (tx) => {
    const payload = queuedRunnerJobPayload({
      ...args.launch.runnerJobPayload,
      reuseKey: runnerReuseKey(args.createArgs.chatThreadId),
    });
    await args.timing.measure(
      "api_dispatch_admission_lock_wait",
      "nested",
      async () => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${args.createArgs.orgId}))`,
        );
      },
    );
    const admissionLockHeldStartedAt = now();
    await lockQueueFirstRunSourceForLaunch({
      tx,
      createArgs: args.createArgs,
    });
    return {
      result: await commitPreparedLaunchUnderLock(tx, args, payload),
      admissionLockHeldStartedAt,
    };
  });
  args.timing.recordElapsed(
    "api_dispatch_admission_lock_held",
    "nested",
    committed.admissionLockHeldStartedAt,
  );
  return committed.result;
}

function buildAtomicLaunchPayload(
  db: Db,
  args: {
    readonly createArgs: CreateAgentRunArgs;
    readonly context: PreparedRunContext;
    readonly run: Pick<RunRecord, "id" | "sessionId" | "shouldCreateSession">;
    readonly timing: ApiDispatchTimingCollector;
  },
): Computed<Promise<PreparedRunnerLaunch>> {
  return buildRunnerJobPayload(db, {
    run: args.run,
    userId: args.createArgs.userId,
    orgId: args.createArgs.orgId,
    resolved: args.context.resolved,
    body: args.context.body,
    artifacts: args.context.artifacts,
    framework: args.context.framework,
    piEdge: args.context.piEdge,
    modelProvider: args.context.modelProvider,
    connectorContext: args.context.connectorContext,
    customConnectorContext: args.context.customConnectorContext,
    permissionManifest: args.context.permissionManifest,
    billableFirewalls: args.context.billableFirewalls,
    modelUsageProvider: args.context.modelUsageProvider,
    apiStartTime: args.createArgs.apiStartTime,
    additionalVolumes: args.context.additionalVolumes,
    additionalVolumeSources: args.context.additionalVolumeSources,
    includeZeroTokenSecret: args.createArgs.includeZeroTokenSecret,
    zeroTokenComputerUseHostId: args.createArgs.zeroTokenComputerUseHostId,
    zeroTokenCloudBrowserEnabled: args.createArgs.zeroTokenCloudBrowserEnabled,
    imageRecognitionAvailable: args.context.imageRecognitionAvailable,
    chatThreadId: args.createArgs.chatThreadId,
    extraEnvironment: args.createArgs.extraEnvironment,
    userTimezone: args.context.userTimezone,
    featureSwitchContext: args.context.featureSwitchContext,
    timing: args.timing,
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
      error: runFailureMessage(error),
      createdAt: run.createdAt.toISOString(),
    },
  };
}

// Compatibility sentinel for rows created by pre-#22608 server versions.
export const BEFORE_DISPATCH_CANCELLED_ERROR =
  "Run dispatch cancelled before runner queue persistence";

interface PreparedRunContext {
  readonly body: CreateRunBody;
  readonly resolved: ResolvedCompose;
  readonly framework: SupportedFramework;
  readonly piEdge: PiEdgeModelConfig | undefined;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: SupportedRunModel | undefined;
  readonly artifacts: readonly ContextArtifact[];
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly imageRecognitionAvailable: boolean;
}

function isPiEdgeEnabledForRun(
  createArgs: CreateAgentRunArgs,
  featureSwitchContext: FeatureSwitchContext,
): boolean {
  return (
    createArgs.chatThreadId !== undefined &&
    isWebChatTriggerSource(createArgs.body.triggerSource) &&
    createArgs.selectedModelOverride === PI_LOOP_MODEL &&
    isFeatureEnabled(FeatureSwitchKey.PiLoop, featureSwitchContext)
  );
}

function resolvePreparedPiEdgeModelConfig(args: {
  readonly createArgs: CreateAgentRunArgs;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
}): PiEdgeModelConfig | undefined {
  if (!isPiEdgeEnabledForRun(args.createArgs, args.featureSwitchContext)) {
    return undefined;
  }
  return resolvePiEdgeModelConfig(args.modelProvider) ?? undefined;
}

async function resolveRunModelProvider(
  db: Db,
  args: CreateAgentRunArgs,
  options: {
    readonly content: AgentComposeContent;
    readonly framework: SupportedFramework;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
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
        resolvePiEdgeCredentials: isPiEdgeEnabledForRun(
          args,
          options.featureSwitchContext,
        ),
      })
    : null;
  signal.throwIfAborted();

  if (!shouldResolveModelProvider || modelProvider) {
    return modelProvider;
  }

  if (args.enforceVm0Credits && args.modelProviderType === "vm0") {
    const creditGate =
      (await checkOrgCreditsForRunAdmission({
        db,
        orgId: args.orgId,
        userId: args.userId,
        modelProviderType: "vm0",
        selectedModel: args.selectedModelOverride,
      })) ?? null;
    signal.throwIfAborted();
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

async function resolvePreparedUserTimezone(input: {
  readonly db: Db;
  readonly args: CreateAgentRunArgs;
  readonly timing: ApiDispatchTimingCollector;
  readonly preloadedUserTimezone: string | null | undefined;
}): Promise<string | undefined> {
  return await input.timing.measure(
    "api_dispatch_prepare_context_load_user_timezone",
    "nested",
    async () => {
      if (input.preloadedUserTimezone !== undefined) {
        return input.preloadedUserTimezone ?? undefined;
      }
      return await loadUserTimezone(input.db, input.args);
    },
    {
      user_timezone_source:
        input.preloadedUserTimezone === undefined ? "database" : "preloaded",
    },
  );
}

async function loadRunConnectorContexts(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorScope: EffectiveConnectorScope;
    readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly timing: ApiDispatchTimingCollector | undefined;
  },
  signal: AbortSignal,
): Promise<{
  readonly storedConnectorSnapshot: StoredConnectorMaterializationSnapshot | null;
  readonly storedConnectorMetadataContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
}> {
  const [storedConnectorSnapshot, customConnectorContext] = await Promise.all([
    measureApiDispatchTiming(
      args.timing,
      "api_dispatch_prepare_context_load_stored_connectors",
      "nested",
      async () => {
        return await loadStoredConnectorMaterializationPlan(
          db,
          {
            orgId: args.orgId,
            userId: args.userId,
            allowedConnectorSlugs: args.connectorScope.allowedConnectorSlugs,
            scopeSource: args.connectorScope.source,
            connectorCatalogSnapshot: args.connectorCatalogSnapshot,
          },
          args.timing,
        );
      },
      storedConnectorTimingDimensions({
        scopeSource: args.connectorScope.source,
      }),
    ),
    measureApiDispatchTiming(
      args.timing,
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
            customConnectorGrants: args.connectorScope.customConnectorGrants,
            featureSwitchContext: args.featureSwitchContext,
            connectorCatalogSnapshot: args.connectorCatalogSnapshot,
          },
          signal,
          args.timing,
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

async function buildResolvedRunBody(
  args: {
    readonly initialBody: CreateRunBody;
    readonly resolved: ResolvedCompose;
    readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<CreateRunBody> {
  const runVars =
    args.initialBody.vars !== undefined
      ? args.initialBody.vars
      : args.resolved.vars;
  const mergedVars = buildMergedVariables({
    persistedEnvironment: args.persistedEnvironment,
    runVars,
  });
  signal.throwIfAborted();

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
  signal.throwIfAborted();

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
  readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
  readonly body: CreateRunBody;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly storedConnectorMetadataContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<PermissionManifest | undefined | CreateRunErrorResult> {
  const result = await settle(
    buildPermissionManifest({
      connectorCatalogSnapshot: args.connectorCatalogSnapshot,
      modelProvider: args.modelProvider,
      permissionPolicies: args.body.permissionPolicies,
      vars: args.body.vars,
      connectorVars: args.storedConnectorMetadataContext.vars,
      connectorSlugs: args.storedConnectorMetadataContext.connectorSlugs,
      customConnectorFirewalls: args.customConnectorContext.firewalls,
      customConnectorPermissionPolicies:
        args.customConnectorContext.permissionPolicies,
      customConnectorIdByFirewallName:
        args.customConnectorContext.customConnectorIdByFirewallName,
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
  readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly skillsRoot: string;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly body: CreateRunBody;
  readonly resolved: ResolvedCompose;
}): PreparedAdditionalVolumes {
  const bodyAdditionalVolumes = args.body.additionalVolumes;
  const injectedSkillVolumes = buildInjectedSkillVolumes(
    {
      injectSkillVolumes: args.createArgs.injectSkillVolumes,
      allowedConnectorSlugs: args.connectorScope.allowedConnectorSlugs,
      connectorCatalogSnapshot: args.connectorCatalogSnapshot,
    },
    args.skillsRoot,
  );
  return mergeAdditionalVolumes({
    prepend: [
      ...buildCustomConnectorSkillVolumes(
        args.customConnectorContext.skills,
        args.skillsRoot,
      ),
      ...(injectedSkillVolumes ?? []),
    ],
    base: prepareAdditionalVolumesWithSource(
      bodyAdditionalVolumes ?? args.resolved.additionalVolumes,
      bodyAdditionalVolumes ? "request_additional_volume" : "unknown",
    ),
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
  readonly modelUsageProvider: SupportedRunModel | undefined;
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
}

function connectorScopeForRuntimeSnapshot(
  scope: EffectiveConnectorScope,
  snapshot: ConnectorRuntimeSnapshot,
): EffectiveConnectorScope {
  if (scope.allowedConnectorSlugs === undefined) {
    return scope;
  }
  return {
    ...scope,
    allowedConnectorSlugs: scope.allowedConnectorSlugs.filter(
      (connectorSlug) => {
        const connector = getConnectorRuntimeConnector(snapshot, connectorSlug);
        return (
          connector !== undefined &&
          [...connector.methods.values()].some((method) => {
            return method.executable;
          })
        );
      },
    ),
  };
}

function connectorScopeFromCreateArgs(
  args: CreateAgentRunArgs,
): EffectiveConnectorScope | null {
  if (!args.connectorScope) {
    return null;
  }
  const source =
    args.connectorScope.allowedConnectorSlugs.length === 0 &&
    args.connectorScope.allowedCustomConnectorIds.length === 0
      ? "empty"
      : (args.connectorScope.source ?? "explicit");
  return {
    allowedConnectorSlugs: args.connectorScope.allowedConnectorSlugs,
    allowedCustomConnectorIds: args.connectorScope.allowedCustomConnectorIds,
    customConnectorGrants: args.connectorScope.customConnectorGrants,
    source,
  };
}

async function resolveEffectiveConnectorScope(
  args: {
    readonly db: Db;
    readonly createArgs: CreateAgentRunArgs;
    readonly resolved: ResolvedCompose;
  },
  signal: AbortSignal,
): Promise<EffectiveConnectorScope | CreateRunErrorResult> {
  const createArgsScope = connectorScopeFromCreateArgs(args.createArgs);
  if (createArgsScope) {
    return createArgsScope;
  }

  const zeroBackedAgent = await loadZeroBackedComposeAgent(args.db, {
    composeId: args.resolved.composeId,
  });
  signal.throwIfAborted();
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
        scope.allowedConnectorSlugs.length === 0 &&
        scope.allowedCustomConnectorIds.length === 0
          ? "empty"
          : "zero_agent",
    };
  }

  return {
    allowedConnectorSlugs: undefined,
    allowedCustomConnectorIds: undefined,
    customConnectorGrants: undefined,
    source: "legacy_all",
  };
}

async function prepareRunBodyContext(
  args: {
    readonly get: PrepareRunContextGet;
    readonly db: Db;
    readonly createArgs: CreateAgentRunArgs;
    readonly preloadedFeatureSwitchContext: FeatureSwitchContext | undefined;
    readonly timing: ApiDispatchTimingCollector;
    readonly initialBody: CreateRunBody;
  },
  signal: AbortSignal,
): Promise<PreparedRunBodyContext | CreateRunErrorResult> {
  const featureSwitchContext = await args.timing.measure(
    "api_dispatch_prepare_context_feature_switches",
    "nested",
    async () => {
      if (args.preloadedFeatureSwitchContext !== undefined) {
        signal.throwIfAborted();
        return args.preloadedFeatureSwitchContext;
      }
      return await args.get(
        loadRunFeatureSwitchContext(args.createArgs, signal),
      );
    },
    {
      feature_switch_context_source:
        args.preloadedFeatureSwitchContext === undefined
          ? "database"
          : "preloaded",
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
  signal.throwIfAborted();
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
      return await resolveEffectiveConnectorScope(
        {
          db: args.db,
          createArgs: args.createArgs,
          resolved,
        },
        signal,
      );
    },
  );
  signal.throwIfAborted();
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
  signal.throwIfAborted();
  const body = await args.timing.measure(
    "api_dispatch_prepare_context_build_resolved_body",
    "nested",
    async () => {
      return await buildResolvedRunBody(
        {
          initialBody: args.initialBody,
          resolved,
          persistedEnvironment,
          featureSwitchContext,
        },
        signal,
      );
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
  signal.throwIfAborted();
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

async function prepareRunConnectorContexts(
  args: {
    readonly db: Db;
    readonly createArgs: CreateAgentRunArgs;
    readonly connectorScope: EffectiveConnectorScope;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
    readonly timing: ApiDispatchTimingCollector;
  },
  signal: AbortSignal,
): Promise<
  Awaited<ReturnType<typeof loadRunConnectorContexts>> | CreateRunErrorResult
> {
  const result = await settle(
    args.timing.measure(
      "api_dispatch_prepare_context_load_connector_contexts",
      "nested",
      async () => {
        return await loadRunConnectorContexts(
          args.db,
          {
            orgId: args.createArgs.orgId,
            userId: args.createArgs.userId,
            connectorScope: args.connectorScope,
            connectorCatalogSnapshot: args.connectorCatalogSnapshot,
            featureSwitchContext: args.featureSwitchContext,
            timing: args.timing,
          },
          signal,
        );
      },
      storedConnectorTimingDimensions({
        scopeSource: args.connectorScope.source,
      }),
    ),
  );
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

async function resolvePreparedRunModelProvider(
  args: {
    readonly db: Db;
    readonly createArgs: CreateAgentRunArgs;
    readonly timing: ApiDispatchTimingCollector;
    readonly bodyContext: PreparedRunBodyContext;
  },
  signal: AbortSignal,
): Promise<ResolvedModelProviderEnvironment | null | CreateRunErrorResult> {
  const { resolved, requestedFramework, featureSwitchContext } =
    args.bodyContext;
  return await args.timing.measure(
    "api_dispatch_prepare_context_resolve_model_provider",
    "nested",
    async () => {
      return await resolveRunModelProvider(
        args.db,
        args.createArgs,
        {
          content: resolved.content,
          framework: requestedFramework,
          featureSwitchContext,
        },
        signal,
      );
    },
  );
}

async function prepareRunRuntimeContext(
  args: {
    readonly db: Db;
    readonly createArgs: CreateAgentRunArgs;
    readonly connectorScope: EffectiveConnectorScope;
    readonly preloadedConnectorCatalogSnapshot?: ConnectorRuntimeSnapshot;
    readonly timing: ApiDispatchTimingCollector;
    readonly bodyContext: PreparedRunBodyContext;
  },
  signal: AbortSignal,
): Promise<PreparedRuntimeContext | CreateRunErrorResult> {
  const { body, resolved, requestedFramework, featureSwitchContext } =
    args.bodyContext;
  const connectorCatalogSnapshot = await connectorCatalogSnapshotForRun(args);
  signal.throwIfAborted();
  const connectorScope = connectorScopeForRuntimeSnapshot(
    args.connectorScope,
    connectorCatalogSnapshot,
  );
  const modelProvider = await resolvePreparedRunModelProvider(args, signal);
  if (isRouteError(modelProvider)) {
    return modelProvider;
  }
  const framework = modelProvider
    ? modelProviderFramework(modelProvider)
    : requestedFramework;
  const connectorContexts = await prepareRunConnectorContexts(
    {
      ...args,
      connectorScope,
      featureSwitchContext,
      connectorCatalogSnapshot,
    },
    signal,
  );
  if (isRouteError(connectorContexts)) {
    return connectorContexts;
  }
  const {
    storedConnectorSnapshot,
    storedConnectorMetadataContext,
    customConnectorContext,
  } = connectorContexts;
  signal.throwIfAborted();

  const storedConnectorTiming = storedConnectorTimingDimensions({
    scopeSource: connectorScope.source,
    connectorCount: storedConnectorSnapshot?.allowedConnectorRows.length ?? 0,
  });
  const overriddenConnectorSecretAliases = overriddenRuntimeSecretAliases([
    modelProvider?.secrets,
    modelProvider?.secretConnectorMap,
    body.secrets,
  ]);
  const connectorContextPromise = materializeStoredConnectorContext(
    storedConnectorSnapshot,
    {
      overriddenSecretAliases: overriddenConnectorSecretAliases,
      timingDimensions: storedConnectorTiming,
    },
    args.timing,
  );
  const permissionManifestPromise = args.timing.measure(
    "api_dispatch_prepare_context_build_permission_manifest",
    "nested",
    async () => {
      return await buildPreparedPermissionManifest({
        connectorCatalogSnapshot,
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
  signal.throwIfAborted();
  if (isRouteError(permissionManifest)) {
    return permissionManifest;
  }
  const finalConnectorContext = await materializeEagerStoredConnectorSecrets(
    args.db,
    storedConnectorSnapshot,
    connectorContext,
    {
      featureSwitchContext,
      ...eagerStoredConnectorSecretInputs({
        content: resolved.content,
        modelProvider,
        connectorContext,
      }),
      environmentSecretPlaceholders:
        permissionManifest?.environmentSecretPlaceholders,
      overriddenSecretAliases: overriddenConnectorSecretAliases,
      timingDimensions: storedConnectorTiming,
    },
    args.timing,
  );
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
    connectorContext: finalConnectorContext,
    customConnectorContext,
    permissionManifest,
    billableFirewalls: modelUsageContext.billableFirewalls,
    modelUsageProvider: modelUsageContext.modelUsageProvider,
    connectorScope,
    connectorCatalogSnapshot,
  };
}

async function connectorCatalogSnapshotForRun(args: {
  readonly db: Db;
  readonly preloadedConnectorCatalogSnapshot?: ConnectorRuntimeSnapshot;
  readonly connectorScope: EffectiveConnectorScope;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<ConnectorRuntimeSnapshot> {
  return (
    args.preloadedConnectorCatalogSnapshot ??
    (await loadConnectorRuntimeSnapshot(args.db, {
      timing: args.timing,
      requestedConnectorCount:
        args.connectorScope.allowedConnectorSlugs?.length,
    }))
  );
}

function prepareRunOutputMetadata(args: {
  readonly createArgs: CreateAgentRunArgs;
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly framework: SupportedFramework;
  readonly piEdge: PiEdgeModelConfig | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly body: CreateRunBody;
  readonly resolved: ResolvedCompose;
}): {
  readonly artifacts: readonly ContextArtifact[];
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
} {
  const additionalVolumes = preparedRunAdditionalVolumes({
    createArgs: args.createArgs,
    connectorScope: args.connectorScope,
    connectorCatalogSnapshot: args.connectorCatalogSnapshot,
    customConnectorContext: args.customConnectorContext,
    skillsRoot:
      args.piEdge === undefined
        ? frameworkSkillsMountPath(args.framework)
        : PI_SKILLS_ROOT,
    featureSwitchContext: args.featureSwitchContext,
    body: args.body,
    resolved: args.resolved,
  });
  const artifacts = artifactsForRun({
    resolved: args.resolved,
    framework: args.framework,
    usePiMemoryPath: args.piEdge !== undefined,
    bodyArtifacts: args.body.artifacts,
  }).artifacts;
  return {
    additionalVolumes: additionalVolumes.volumes,
    additionalVolumeSources: additionalVolumes.sources,
    artifacts,
  };
}

function isImageRecognitionAvailableForRun(args: {
  readonly includeZeroTokenSecret: boolean | undefined;
  readonly selectedModel: string | undefined;
}): boolean {
  return (
    args.includeZeroTokenSecret === true &&
    getModelImageInputSupport(args.selectedModel) === "unsupported"
  );
}

interface PrepareRunContextInput {
  readonly db: Db;
  readonly args: CreateAgentRunArgs;
  readonly timing: ApiDispatchTimingCollector;
  readonly preloadedFeatureSwitchContext: FeatureSwitchContext | undefined;
  readonly preloadedUserTimezone: string | null | undefined;
  readonly preloadedConnectorCatalogSnapshot:
    | ConnectorRuntimeSnapshot
    | undefined;
}

async function prepareRunContexts(
  get: PrepareRunContextGet,
  input: PrepareRunContextInput,
  initialBody: CreateRunBody,
  signal: AbortSignal,
): Promise<
  | CreateRunErrorResult
  | {
      readonly bodyContext: PreparedRunBodyContext;
      readonly runtimeContext: PreparedRuntimeContext;
    }
> {
  const bodyContext = await prepareRunBodyContext(
    {
      get,
      db: input.db,
      createArgs: input.args,
      preloadedFeatureSwitchContext: input.preloadedFeatureSwitchContext,
      timing: input.timing,
      initialBody,
    },
    signal,
  );
  if (isRouteError(bodyContext)) {
    return bodyContext;
  }
  const runtimeContext = await prepareRunRuntimeContext(
    {
      db: input.db,
      createArgs: input.args,
      connectorScope: bodyContext.connectorScope,
      preloadedConnectorCatalogSnapshot:
        input.preloadedConnectorCatalogSnapshot,
      timing: input.timing,
      bodyContext,
    },
    signal,
  );
  if (isRouteError(runtimeContext)) {
    return runtimeContext;
  }
  return { bodyContext, runtimeContext };
}

function prepareRunContext(
  input: PrepareRunContextInput,
  signal: AbortSignal,
): Computed<Promise<PreparedRunContext | CreateRunErrorResult>> {
  const { db, args, timing } = input;
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

      const contexts = await prepareRunContexts(
        get,
        input,
        initialBody,
        signal,
      );
      if (isRouteError(contexts)) {
        return contexts;
      }
      const { bodyContext, runtimeContext } = contexts;
      const { body, resolved } = bodyContext;
      const piEdge = resolvePreparedPiEdgeModelConfig({
        createArgs: args,
        featureSwitchContext: bodyContext.featureSwitchContext,
        modelProvider: runtimeContext.modelProvider,
      });

      const validation = await timing.measure(
        "api_dispatch_prepare_context_validate_environment",
        "nested",
        async () => {
          return await Promise.resolve(
            validateRunEnvironmentReferences({
              resolved,
              body,
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

      const userTimezone = await resolvePreparedUserTimezone(input);
      signal.throwIfAborted();

      const outputMetadata = await timing.measure(
        "api_dispatch_prepare_context_prepare_output_metadata",
        "nested",
        async () => {
          return await Promise.resolve(
            prepareRunOutputMetadata({
              createArgs: args,
              connectorScope: runtimeContext.connectorScope,
              connectorCatalogSnapshot: runtimeContext.connectorCatalogSnapshot,
              customConnectorContext: runtimeContext.customConnectorContext,
              framework: runtimeContext.framework,
              piEdge,
              featureSwitchContext: bodyContext.featureSwitchContext,
              body,
              resolved,
            }),
          );
        },
      );

      return {
        body,
        resolved,
        framework: runtimeContext.framework,
        piEdge,
        modelProvider: runtimeContext.modelProvider,
        connectorContext: runtimeContext.connectorContext,
        customConnectorContext: runtimeContext.customConnectorContext,
        permissionManifest: runtimeContext.permissionManifest,
        billableFirewalls: runtimeContext.billableFirewalls,
        modelUsageProvider: runtimeContext.modelUsageProvider,
        artifacts: outputMetadata.artifacts,
        additionalVolumes: outputMetadata.additionalVolumes,
        additionalVolumeSources: outputMetadata.additionalVolumeSources,
        userTimezone,
        featureSwitchContext: bodyContext.featureSwitchContext,
        imageRecognitionAvailable: isImageRecognitionAvailableForRun({
          includeZeroTokenSecret: args.includeZeroTokenSecret,
          selectedModel:
            runtimeContext.modelProvider?.selectedModel ??
            args.selectedModelOverride,
        }),
      };
    },
  );
}

async function committedAtomicLaunchResponse(args: {
  readonly createArgs: CreateAgentRunArgs;
  readonly committed: CommittedAtomicLaunchResult;
  readonly timing: ApiDispatchTimingCollector;
  readonly launch: PreparedRunnerLaunch;
}): Promise<Extract<CreateRunRouteResult, { readonly status: 201 }>> {
  if (args.committed.threadSessionBinding) {
    recordThreadSessionBindingTelemetry({
      binding: args.committed.threadSessionBinding,
      runStatus: args.committed.kind,
    });
  }
  if (args.committed.kind === "queued") {
    recordQueuedRunEnqueueTelemetry({
      runId: args.committed.run.id,
      queueDepth: args.committed.queueDepth,
      timestamp: args.committed.telemetryTimestamp,
    });
    ingestRunContextSnapshot(args.committed.runContextSnapshot);
    await publishQueueChangedSafely({
      orgId: args.createArgs.orgId,
      runId: args.committed.run.id,
    });
    args.timing.flush({
      runId: args.committed.run.id,
      runnerGroup: args.committed.runnerJobPayload.runnerGroup,
      profile: args.committed.runnerJobPayload.profile,
      dispatchPath: "direct",
      ...(args.createArgs.timingDimensions
        ? { dimensions: args.createArgs.timingDimensions }
        : {}),
      ...(args.createArgs.body.triggerSource
        ? { triggerSource: args.createArgs.body.triggerSource }
        : {}),
    });
    const response = createdRunResponse(args.committed.run, {
      status: "queued",
    });
    return args.committed.queueFirstClaim
      ? { ...response, queueFirstClaim: args.committed.queueFirstClaim }
      : response;
  }

  ingestRunContextSnapshot(args.committed.runContextSnapshot);
  const dispatchedProfile = args.committed.runnerJobPayload.profile;
  const pendingActivation: PendingRunActivation = {
    apiStartTime: args.createArgs.apiStartTime,
    chatThreadId: args.createArgs.chatThreadId,
    piEdgeTurn:
      args.launch.piEdge === undefined
        ? undefined
        : {
            runId: args.committed.run.id,
            userId: args.createArgs.userId,
            orgId: args.createArgs.orgId,
            prompt: args.launch.piEdge.prompt,
            systemPrompt: args.launch.piEdge.systemPrompt,
            model: args.launch.piEdge.model,
            ...(args.launch.piEdge.usage === undefined
              ? {}
              : { usage: args.launch.piEdge.usage }),
            executionEnv: args.launch.piEdge.executionEnv,
            skillSnapshot: args.launch.piEdge.skillSnapshot,
            runnerGroup: args.committed.runnerJobPayload.runnerGroup,
            apiStartTime: args.createArgs.apiStartTime,
          },
    runnerNotification: {
      runnerGroup: args.committed.runnerJobPayload.runnerGroup,
      runId: args.committed.run.id,
      profile: dispatchedProfile,
      reuseKey: args.committed.runnerJobPayload.reuseKey,
      cliAgentSessionId: args.committed.runnerJobPayload.cliAgentSessionId,
      historyGenerationRunId:
        args.committed.runnerJobPayload.historyGenerationRunId,
      piExecutionMode:
        args.committed.runnerJobPayload.executionContext.piExecutionMode,
      createdAt: args.committed.runnerJobCreatedAt,
    },
  };
  args.timing.flush({
    runId: args.committed.run.id,
    runnerGroup: args.committed.runnerJobPayload.runnerGroup,
    profile: dispatchedProfile,
    dispatchPath: "direct",
    ...(args.createArgs.timingDimensions
      ? { dimensions: args.createArgs.timingDimensions }
      : {}),
    ...(args.createArgs.body.triggerSource
      ? { triggerSource: args.createArgs.body.triggerSource }
      : {}),
  });
  const response = createdRunResponse(args.committed.run, {
    status: "pending",
  });
  return args.committed.queueFirstClaim
    ? {
        ...response,
        queueFirstClaim: args.committed.queueFirstClaim,
        pendingActivation,
      }
    : { ...response, pendingActivation };
}

function flushQueueFirstClaimLostTiming(args: {
  readonly createArgs: CreateAgentRunArgs;
  readonly identity: LaunchRunIdentity;
  readonly launch: PreparedRunnerLaunch;
  readonly timing: ApiDispatchTimingCollector;
}): void {
  args.timing.flush({
    runId: args.identity.runId,
    runnerGroup: args.launch.runnerJobPayload.runnerGroup,
    profile: args.launch.runnerJobPayload.profile,
    dispatchPath: "direct",
    dimensions: {
      ...args.createArgs.timingDimensions,
      queue_first_launch_outcome: "claim_lost",
    },
    ...(args.createArgs.body.triggerSource
      ? { triggerSource: args.createArgs.body.triggerSource }
      : {}),
  });
}

interface AtomicLaunchRunInput {
  readonly db: Db;
  readonly args: CreateAgentRunArgs;
  readonly context: PreparedRunContext;
  readonly timing: ApiDispatchTimingCollector;
}

function isQueuePayloadRequiredResult(
  result: unknown,
): result is QueuePayloadRequiredResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "kind" in result &&
    result.kind === "queue-payload-required"
  );
}

async function finalizeAtomicLaunchCommit(
  args: {
    readonly input: AtomicLaunchRunInput;
    readonly identity: LaunchRunIdentity;
    readonly launch: PreparedRunnerLaunch;
    readonly committed: AtomicLaunchCommitAttempt;
  },
  signal: AbortSignal,
): Promise<QueueFirstAgentRunResult | QueuePayloadRequiredResult> {
  if (isReturnableRouteError(args.committed, signal)) {
    return args.committed;
  }
  if (args.committed.kind === "queue-first-claim-lost") {
    flushQueueFirstClaimLostTiming({
      createArgs: args.input.args,
      identity: args.identity,
      launch: args.launch,
      timing: args.input.timing,
    });
    return args.committed;
  }
  if (args.committed.kind === "thread-session-snapshot-stale") {
    return args.committed;
  }
  if (args.committed.kind === "queue-payload-required") {
    return args.committed;
  }
  return await committedAtomicLaunchResponse({
    createArgs: args.input.args,
    committed: args.committed,
    timing: args.input.timing,
    launch: args.launch,
  });
}

async function completeQueuePayloadLaunch(
  args: {
    readonly input: AtomicLaunchRunInput;
    readonly identity: LaunchRunIdentity;
    readonly callbackRows: readonly AgentRunCallbackInsert[];
    readonly launch: PreparedRunnerLaunch;
    readonly commitLaunch: CommitAtomicLaunch;
  },
  signal: AbortSignal,
): Promise<QueueFirstAgentRunResult> {
  signal.throwIfAborted();
  const encryptedQueuedParams = await settle(
    encryptQueuedRunnerJobPayload(
      args.launch.runnerJobPayload,
      args.input.context.featureSwitchContext,
    ),
  );
  signal.throwIfAborted();

  if (!encryptedQueuedParams.ok) {
    const retried = await args.commitLaunch(undefined);
    const finalizedRetry = await finalizeAtomicLaunchCommit(
      {
        input: args.input,
        identity: args.identity,
        launch: args.launch,
        committed: retried,
      },
      signal,
    );
    if (!isQueuePayloadRequiredResult(finalizedRetry)) {
      return finalizedRetry;
    }
    signal.throwIfAborted();
    return await commitFailedLaunch({
      db: args.input.db,
      createArgs: args.input.args,
      context: args.input.context,
      identity: args.identity,
      callbackRows: args.callbackRows,
      error: encryptedQueuedParams.error,
      timing: args.input.timing,
    });
  }

  const committed = await args.commitLaunch(encryptedQueuedParams.value);
  const finalized = await finalizeAtomicLaunchCommit(
    {
      input: args.input,
      identity: args.identity,
      launch: args.launch,
      committed,
    },
    signal,
  );
  if (isQueuePayloadRequiredResult(finalized)) {
    signal.throwIfAborted();
    throw new Error("Queued launch still required encrypted payload");
  }
  return finalized;
}

function createAtomicLaunchRun(
  input: AtomicLaunchRunInput,
  signal: AbortSignal,
): Computed<Promise<QueueFirstAgentRunResult>> {
  return computed(async (get): Promise<QueueFirstAgentRunResult> => {
    const identity = prepareLaunchRunIdentity({
      resolved: input.context.resolved,
    });
    if (!input.args.queueOnConcurrencyLimit) {
      const preflightConcurrency = await checkRunConcurrencyPreflight({
        db: input.db,
        orgId: input.args.orgId,
        timing: input.timing,
      });
      signal.throwIfAborted();
      if (preflightConcurrency) {
        return preflightConcurrency;
      }
    }

    const callbackRows = await prepareRunCallbackRows({
      runId: identity.runId,
      callbacks: input.args.callbacks,
      featureSwitchContext: input.context.featureSwitchContext,
      timing: input.timing,
    });
    signal.throwIfAborted();

    const launchResult = await settle(
      input.timing.measure(
        "api_dispatch_build_runner_job_payload",
        "top_level",
        async () => {
          return await get(
            buildAtomicLaunchPayload(input.db, {
              createArgs: input.args,
              context: input.context,
              run: {
                id: identity.runId,
                sessionId: identity.sessionId,
                shouldCreateSession: identity.shouldCreateSession,
              },
              timing: input.timing,
            }),
          );
        },
      ),
    );
    signal.throwIfAborted();
    if (!launchResult.ok) {
      return await commitFailedLaunch({
        db: input.db,
        createArgs: input.args,
        context: input.context,
        identity,
        callbackRows,
        error: launchResult.error,
        timing: input.timing,
      });
    }

    const launch = launchResult.value;

    const commitLaunch: CommitAtomicLaunch = async (
      encryptedQueuedParams: string | undefined,
    ) => {
      return await input.timing.measure(
        "api_dispatch_insert_run_with_concurrency",
        "top_level",
        async () => {
          return await commitPreparedLaunch({
            db: input.db,
            createArgs: input.args,
            context: input.context,
            identity,
            callbackRows,
            launch,
            encryptedQueuedParams,
            timing: input.timing,
          });
        },
      );
    };

    const committed = await commitLaunch(undefined);
    const finalized = await finalizeAtomicLaunchCommit(
      {
        input,
        identity,
        launch,
        committed,
      },
      signal,
    );
    if (isQueuePayloadRequiredResult(finalized)) {
      return await completeQueuePayloadLaunch(
        {
          input,
          identity,
          callbackRows,
          launch,
          commitLaunch,
        },
        signal,
      );
    }
    return finalized;
  });
}

interface PreparedAgentRun {
  readonly args: CreateAgentRunArgs;
  readonly context: PreparedRunContext;
  readonly timing: ApiDispatchTimingCollector;
}

interface PrepareAgentRunArgs {
  readonly args: CreateAgentRunArgs;
  readonly timing: ApiDispatchTimingCollector;
  readonly checkOrgPlanStatusBeforeContext: boolean;
  readonly preloadedFeatureSwitchContext?: FeatureSwitchContext;
  // Undefined means not preloaded; null is an authoritative missing value.
  readonly preloadedUserTimezone?: string | null;
  readonly preloadedConnectorCatalogSnapshot?: ConnectorRuntimeSnapshot;
}

interface CompleteAgentRunArgs {
  readonly prepared: PreparedAgentRun;
  readonly finalAppendSystemPrompt: CreateRunBody["appendSystemPrompt"];
}

function finalizePreparedRunContext(
  prepared: PreparedAgentRun,
  finalAppendSystemPrompt: CreateRunBody["appendSystemPrompt"],
): PreparedRunContext {
  return {
    ...prepared.context,
    body: withFinalRunAppendSystemPrompt(
      {
        ...prepared.context.body,
        appendSystemPrompt: finalAppendSystemPrompt,
      },
      prepared.context.framework,
      prepared.args.chatThreadId,
      prepared.context.imageRecognitionAvailable,
    ),
  };
}

export const prepareAgentRun$ = command(
  async (
    { get, set },
    input: PrepareAgentRunArgs,
    signal: AbortSignal,
  ): Promise<PreparedAgentRun | CreateRunErrorResult> => {
    assertThreadBoundRunHasQueueAssociation(input.args);
    // A preview request that passed the protection guard gives its sandbox CLI
    // the same bypass through the existing user-environment channel.
    const previewAutomationBypass = get(previewAutomationBypass$);
    const args = previewAutomationBypass
      ? {
          ...input.args,
          extraEnvironment: {
            ...input.args.extraEnvironment,
            [VERCEL_AUTOMATION_BYPASS_ENV]: previewAutomationBypass,
          },
        }
      : input.args;
    const { timing } = input;
    const db = set(writeDb$);
    if (input.checkOrgPlanStatusBeforeContext) {
      const tierGate = await timing.measure(
        "api_dispatch_check_org_tier",
        "top_level",
        async () => {
          return await checkOrgRunPlanStatus(db, { orgId: args.orgId });
        },
      );
      signal.throwIfAborted();
      if (tierGate) {
        return tierGate;
      }
    }

    const context = await timing.measure(
      "api_dispatch_prepare_run_context",
      "top_level",
      async () => {
        return await get(
          prepareRunContext(
            {
              db,
              args,
              timing,
              preloadedFeatureSwitchContext:
                input.preloadedFeatureSwitchContext,
              preloadedUserTimezone: input.preloadedUserTimezone,
              preloadedConnectorCatalogSnapshot:
                input.preloadedConnectorCatalogSnapshot,
            },
            signal,
          ),
        );
      },
    );
    signal.throwIfAborted();
    if (isRouteError(context)) {
      return context;
    }

    return { args, context, timing };
  },
);

export const completeAgentRun$ = command(
  async (
    { get, set },
    input: CompleteAgentRunArgs,
    signal: AbortSignal,
  ): Promise<QueueFirstAgentRunResult> => {
    assertThreadBoundRunHasQueueAssociation(input.prepared.args);
    const db = set(writeDb$);
    const { args, timing } = input.prepared;
    const context = finalizePreparedRunContext(
      input.prepared,
      input.finalAppendSystemPrompt,
    );
    signal.throwIfAborted();

    const modelProviderType =
      context.modelProvider?.type ?? args.modelProviderType;
    const selectedModel =
      context.modelProvider?.selectedModel ?? args.selectedModelOverride;
    const admissionGate = await timing.measure(
      "api_dispatch_check_run_admission",
      "top_level",
      async () => {
        return await checkFinalRunAdmission(
          db,
          {
            orgId: args.orgId,
            userId: args.userId,
            modelProviderType,
            selectedModel,
            enforceVm0Credits:
              args.enforceVm0Credits === true &&
              context.modelProvider?.type === "vm0",
            timing,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    if (admissionGate) {
      return admissionGate;
    }

    const result = await get(
      createAtomicLaunchRun(
        {
          db,
          args,
          context,
          timing,
        },
        signal,
      ),
    );
    // The run and runner job are durable now. Observe request cancellation for
    // diagnostics, but let the commit-owned activation finish independently.
    if (signal.aborted) {
      L.debug("Request aborted after run launch commit", {
        orgId: args.orgId,
      });
    }
    if (
      !("status" in result) ||
      result.status !== 201 ||
      result.pendingActivation === undefined
    ) {
      return result;
    }

    await set(activatePendingRun$, result.pendingActivation);
    if (signal.aborted) {
      L.debug("Request remained aborted after run activation", {
        runId: result.pendingActivation.runnerNotification.runId,
      });
    }
    const { pendingActivation: _pendingActivation, ...activatedResult } =
      result;
    return activatedResult;
  },
);

export const createAgentRun$ = command(
  async (
    { set },
    args: CreateAgentRunArgs,
    signal: AbortSignal,
  ): Promise<CreateRunRouteResult> => {
    const timing = args.timing ?? new ApiDispatchTimingCollector();
    timing.recordElapsed(
      "api_dispatch_pre_create_agent_run",
      "top_level",
      args.apiStartTime,
    );
    const prepared = await set(
      prepareAgentRun$,
      { args, timing, checkOrgPlanStatusBeforeContext: true },
      signal,
    );
    if (isRouteError(prepared)) {
      return prepared;
    }
    const result = await set(
      completeAgentRun$,
      {
        prepared,
        finalAppendSystemPrompt: args.body.appendSystemPrompt,
      },
      signal,
    );
    if (isQueueFirstRunClaimLost(result)) {
      throw new Error("Direct run unexpectedly lost a queue-first claim");
    }
    if (isThreadSessionSnapshotStale(result)) {
      throw new Error("Direct run unexpectedly used a stale thread session");
    }
    return result;
  },
);
