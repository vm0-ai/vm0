import { command, type Getter } from "ccstate";
import {
  DEFAULT_PROFILE,
  type StorageManifest,
  type StoredExecutionContext,
} from "@vm0/api-contracts/contracts/runners";
import {
  MODEL_PROVIDER_TYPES,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  type CreateRunResponse,
  type RunStatus,
  unifiedRunRequestSchema,
} from "@vm0/api-contracts/contracts/runs";
import {
  isSupportedFramework,
  MOUNT_PATH_TEMPLATE,
  type SupportedFramework,
} from "@vm0/core";
import {
  expandVariables,
  extractAndGroupVariables,
} from "@vm0/core/variable-expander";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { conversations } from "@vm0/db/schema/conversation";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { secrets as secretsTable } from "@vm0/db/schema/secret";
import { userCache } from "@vm0/db/schema/user-cache";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, count, eq, gt, or, sql } from "drizzle-orm";
import type { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import {
  badRequestMessage,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { writeDb$, type Db } from "../external/db";
import { publishRunnerJobNotification } from "../external/realtime";
import { now, nowDate } from "../external/time";
import { safeAsync } from "../utils";
import { decryptSecretValue, encryptSecretsMap } from "./crypto.utils";
import { prepareAgentRunStorageManifest } from "./agent-run-storage.service";

const PENDING_RUN_TTL_MS = 15 * 60 * 1000;
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

type CreateRunBody = z.infer<typeof unifiedRunRequestSchema>;
type ComputedGetter = Getter;

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
}

interface ResolvedModelProviderEnvironment {
  readonly type: ModelProviderType;
  readonly environment: Record<string, string>;
  readonly secrets: Record<string, string>;
  readonly selectedModel: string | null;
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
  | ApiErrorResponse<429, "CONCURRENT_RUN_LIMIT">
  | ApiErrorResponse<503, "PROVIDER_UNAVAILABLE">;

type CreateRunErrorResult = Exclude<
  CreateRunRouteResult,
  { readonly status: 201 }
>;

function forbidden(message: string): ApiErrorResponse<403, "FORBIDDEN"> {
  return {
    status: 403,
    body: { error: { message, code: "FORBIDDEN" } },
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
    type,
    environment,
    secrets: { [config.secretName]: secretValue },
    selectedModel: model || null,
  };
}

async function resolveModelProviderEnvironment(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly framework: SupportedFramework;
  },
): Promise<ResolvedModelProviderEnvironment | null> {
  const rows = await db
    .select({
      type: modelProviders.type,
      userId: modelProviders.userId,
      isDefault: modelProviders.isDefault,
      selectedModel: modelProviders.selectedModel,
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
    if (!isModelProviderType(row.type)) {
      continue;
    }
    const config = MODEL_PROVIDER_TYPES[row.type];
    if (
      !isSingleSecretModelProviderConfig(config) ||
      config.framework !== args.framework ||
      !row.encryptedValue
    ) {
      continue;
    }
    return modelProviderEnvironment(
      row.type,
      config,
      decryptSecretValue(row.encryptedValue),
      row.selectedModel,
    );
  }

  return null;
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
      : await loadResumeSession(db, session.conversationId);

  return {
    ...resolved,
    artifacts: session.artifacts ?? [],
    sessionId: session.id,
    continuedFromSessionId: session.id,
    resumeSession,
  };
}

async function resolveByCheckpointId(
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
    resumeSession: await loadResumeSession(db, row.conversationId),
  };
}

async function loadResumeSession(
  db: Db,
  conversationId: string,
): Promise<StoredExecutionContext["resumeSession"] | undefined> {
  const [conversation] = await db
    .select({
      cliAgentSessionId: conversations.cliAgentSessionId,
      cliAgentSessionHistory: conversations.cliAgentSessionHistory,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!conversation?.cliAgentSessionHistory) {
    return undefined;
  }

  return {
    sessionId: conversation.cliAgentSessionId,
    sessionHistory: conversation.cliAgentSessionHistory,
  };
}

async function resolveCompose(
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
    return await resolveByCheckpointId(db, body.checkpointId, userId, orgId);
  }
  if (body.sessionId) {
    return await resolveBySessionId(db, body.sessionId, userId, orgId);
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
): { readonly framework: SupportedFramework } | CreateRunErrorResult {
  const framework = resolveFramework(content);
  if (!framework) {
    return badRequestMessage(
      "Agent must have a supported framework configured",
    );
  }

  const missing = missingEnvironmentReferences(content, vars, secrets);
  if (missing.length > 0) {
    return badRequestMessage(`Missing required values: ${missing.join(", ")}`);
  }

  return { framework };
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

  await tx.insert(zeroRuns).values({
    id: run.id,
    triggerSource: args.body.triggerSource ?? "cli",
    modelProvider: args.modelProvider?.type ?? null,
    selectedModel: args.modelProvider?.selectedModel ?? null,
  });

  return run;
}

function buildStoredExecutionContext(args: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly resolved: ResolvedCompose;
  readonly body: CreateRunBody;
  readonly framework: SupportedFramework;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly apiStartTime: number;
  readonly storageManifest: StorageManifest;
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
}): StoredExecutionContext {
  const secrets = {
    ...args.modelProvider?.secrets,
    ...args.body.secrets,
  };
  return {
    workingDir: frameworkWorkingDir(args.framework),
    storageManifest: args.storageManifest,
    environment: expandEnvironment(
      args.resolved.content,
      args.body.vars,
      Object.keys(secrets).length > 0 ? secrets : undefined,
      args.modelProvider?.environment,
    ),
    resumeSession: args.resolved.resumeSession ?? null,
    encryptedSecrets: encryptSecretsMap(
      Object.keys(secrets).length > 0 ? secrets : null,
    ),
    secretConnectorMap: null,
    secretConnectorMetadataMap: null,
    cliAgentType: args.framework,
    debugNoMockClaude: args.body.debugNoMockClaude || undefined,
    debugNoMockCodex: args.body.debugNoMockCodex || undefined,
    captureNetworkBodies: args.body.captureNetworkBodies || undefined,
    apiStartTime: args.apiStartTime,
    firewalls: undefined,
    networkPolicies: undefined,
    disallowedTools: args.body.disallowedTools,
    tools: args.body.tools,
    settings: args.body.settings,
    experimentalProfile: runnerProfile(args.resolved.content),
    featureFlags: {},
    billableFirewalls: [],
    modelUsageProvider: args.modelProvider?.selectedModel ?? undefined,
  };
}

async function markRunFailed(
  db: Db,
  runId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "Run failed";
  await db
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
    );
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
    readonly apiStartTime: number;
    readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  },
): Promise<{ readonly status: RunStatus; readonly sandboxId?: string }> {
  await db
    .update(agentRuns)
    .set({ lastHeartbeatAt: nowDate() })
    .where(and(eq(agentRuns.id, args.run.id), eq(agentRuns.status, "pending")));

  const group =
    runnerGroup(args.resolved.content) ?? optionalEnv("RUNNER_DEFAULT_GROUP");
  if (!group) {
    throw new Error("No executor configured: set RUNNER_DEFAULT_GROUP");
  }
  if (!isOfficialRunnerGroup(group)) {
    throw new Error("Only vm0/* runner groups are supported");
  }

  const profile = runnerProfile(args.resolved.content);
  const storageManifest = await prepareAgentRunStorageManifest({
    get,
    db,
    content: args.resolved.content,
    vars: args.body.vars,
    agentOrgId: args.resolved.orgId,
    runtimeOrgId: args.orgId,
    userId: args.userId,
    artifacts: args.artifacts,
    volumeVersionOverrides: args.resolved.volumeVersions,
    additionalVolumes: args.additionalVolumes,
    framework: args.framework,
  });
  const storedContext = buildStoredExecutionContext({
    ...args,
    runId: args.run.id,
    storageManifest,
  });

  await db.insert(runnerJobQueue).values({
    runId: args.run.id,
    runnerGroup: group,
    profile,
    sessionId: storedContext.resumeSession?.sessionId ?? null,
    executionContext: storedContext,
    expiresAt: new Date(now() + 2 * 60 * 60 * 1000),
  });

  await db
    .update(agentRuns)
    .set({ runnerGroup: group })
    .where(eq(agentRuns.id, args.run.id));

  await publishRunnerJobNotification(group, args.run.id, profile);

  return { status: "pending" };
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

export const createAgentRun$ = command(
  async (
    { get, set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly body: CreateRunBody;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<CreateRunRouteResult> => {
    const db = set(writeDb$);

    const captureGate = await enforceCaptureNetworkBodiesGate(
      db,
      args.userId,
      args.body.captureNetworkBodies,
    );
    signal.throwIfAborted();
    if (captureGate) {
      return captureGate;
    }

    const resolved = await resolveCompose(
      db,
      args.body,
      args.userId,
      args.orgId,
    );
    signal.throwIfAborted();
    if (isRouteError(resolved)) {
      return resolved;
    }

    if (resolved.orgId !== args.orgId) {
      return notFound("Resource not found");
    }

    const validation = validateCompose(
      resolved.content,
      args.body.vars,
      args.body.secrets,
    );
    if (isRouteError(validation)) {
      return validation;
    }

    const modelProvider = hasExplicitFrameworkApiKey(
      resolved.content,
      validation.framework,
    )
      ? null
      : await resolveModelProviderEnvironment(db, {
          orgId: args.orgId,
          userId: args.userId,
          framework: validation.framework,
        });
    signal.throwIfAborted();
    if (
      !hasExplicitFrameworkApiKey(resolved.content, validation.framework) &&
      !modelProvider
    ) {
      return providerUnavailable(
        `No model provider configured and ${frameworkApiKeyEnv(validation.framework)} is not declared in compose environment`,
      );
    }

    const artifacts = artifactsForRun({
      resolved,
      framework: validation.framework,
      bodyArtifacts: args.body.artifacts,
    });
    const additionalVolumes =
      args.body.additionalVolumes ?? resolved.additionalVolumes;

    const transactionResult = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${args.orgId}))`,
      );
      const concurrency = await checkRunConcurrencyLimit(tx, args.orgId);
      if (concurrency) {
        return concurrency;
      }
      return await insertRunRecord(tx, {
        userId: args.userId,
        orgId: args.orgId,
        resolved,
        body: args.body,
        artifacts,
        additionalVolumes,
        modelProvider,
      });
    });
    signal.throwIfAborted();

    if (isRouteError(transactionResult)) {
      return transactionResult;
    }

    const dispatchResult = await safeAsync(() => {
      return dispatchRun(get, db, {
        run: transactionResult,
        userId: args.userId,
        orgId: args.orgId,
        resolved,
        body: args.body,
        artifacts,
        framework: validation.framework,
        modelProvider,
        apiStartTime: args.apiStartTime,
        additionalVolumes,
      });
    });
    signal.throwIfAborted();

    if ("ok" in dispatchResult) {
      return createdRunResponse(transactionResult, dispatchResult.ok);
    }

    await markRunFailed(db, transactionResult.id, dispatchResult.error);
    signal.throwIfAborted();
    return failedRunResponse(transactionResult, dispatchResult.error);
  },
);
