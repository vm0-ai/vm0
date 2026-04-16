import { eq, and, sql } from "drizzle-orm";
import {
  resolveFirewallPolicies,
  toFirewallPolicies,
  orgTierSchema,
  isFeatureEnabled,
  FeatureSwitchKey,
  getCustomSkillStorageName,
  type TriggerSource,
  type FirewallPolicies,
  type ConnectorType,
  type RunStatus,
  connectorTypeSchema,
} from "@vm0/core";
import {
  insertRunRecord,
  buildAndDispatchRun,
  loadCompose,
  markRunFailed,
  registerCallbacks,
  type CreateRunResult,
  type CreateRunParams,
  type CreateRunRecordResult,
} from "../infra/run";
import { resolveStartRunCompose } from "./zero-run-validation";
import {
  checkRunConcurrencyLimit,
  authorizeCompose,
  validateComposeRequirements,
} from "./zero-run-policy";
import {
  enqueueRun,
  drainOrgQueue,
  dispatchQueuedZeroRun,
} from "./zero-run-queue-service";
import { generateZeroToken, generateSandboxToken } from "../auth/sandbox-token";
import { loadFeatureSwitchOverrides } from "./user/feature-switches-service";
import {
  buildZeroExecutionContext,
  MODEL_PROVIDER_ENV_VARS,
} from "./build-zero-context";
import { getOrgMetadata } from "./org/org-metadata-service";
import {
  isConcurrentRunLimit,
  insufficientCredits,
  noModelProvider,
} from "../shared/errors";
import { modelProviders } from "../../db/schema/model-provider";
import { orgMetadata } from "../../db/schema/org-metadata";
import { orgMembersMetadata } from "../../db/schema/org-members-metadata";
import { ORG_SENTINEL_USER_ID } from "./org/org-sentinel";
import type { AgentComposeYaml } from "../infra/agent-compose/types";
import {
  DISALLOWED_TOOLS,
  buildAgentPrompt,
  buildAutoSkillGuidance,
} from "./agent-prompt";
import { zeroAgents } from "../../db/schema/zero-agent";
import { zeroRuns } from "../../db/schema/zero-run";
import { userConnectors } from "../../db/schema/user-connector";
import {
  consumeCaptureNetworkBodies,
  getUserPreferences,
} from "./user/user-preferences-service";
import { getCachedUser } from "../auth/user-cache-service";
import { buildUserInfo, type UserInfoOptions } from "./integration-prompt";
import { logger } from "../shared/logger";

const log = logger("service:zero-run");

/**
 * Parameters accepted by createZeroRun().
 * All zero trigger paths (web, schedule, telegram, slack, email, github)
 * use this interface to create agent runs with consistent defaults.
 */
interface ZeroRunParams {
  userId: string;
  prompt: string;
  agentId: string;
  triggerSource: TriggerSource;
  sessionId?: string;
  appendSystemPrompt?: string;
  modelProvider?: string;
  callbacks?: Array<{ url: string; secret: string; payload: unknown }>;
  scheduleId?: string;
  triggerAgentId?: string;
  /** Extra user info fields merged into the base # Current User Info block. */
  userInfoExtras?: UserInfoOptions;
}

/**
 * Pre-flight check: ensure the org has sufficient credits for VM0 runs.
 * Skips for non-VM0 provider runs. Queries orgMetadata + orgMembersMetadata.
 *
 * Accepts an optional `db` parameter so callers running inside a transaction
 * (e.g. dequeueNextAtomic with pg_advisory_xact_lock) can pass the transaction
 * object and keep all reads within the same isolation boundary.
 */
export async function checkOrgCredits(
  orgId: string,
  userId: string,
  modelProvider: string | null | undefined,
  db: typeof globalThis.services.db = globalThis.services.db,
): Promise<void> {
  // Explicit non-VM0 provider — skip check entirely
  if (modelProvider && modelProvider !== "vm0") {
    return;
  }

  // Determine if this is a VM0 run
  let isVm0 = modelProvider === "vm0";

  if (!isVm0 && !modelProvider) {
    // Resolve org default provider to determine if this is a VM0 run
    const [defaultProvider] = await db
      .select({ type: modelProviders.type })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, orgId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
          eq(modelProviders.isDefault, true),
        ),
      )
      .limit(1);
    isVm0 = defaultProvider?.type === "vm0";
  }

  // Per-member credit cap check — only for VM0 runs
  if (isVm0) {
    const [memberRow] = await db
      .select({ creditEnabled: orgMembersMetadata.creditEnabled })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      )
      .limit(1);

    if (memberRow?.creditEnabled === false) {
      throw insufficientCredits();
    }
  }

  // Read credits from org_metadata
  const [orgRow] = await db
    .select({ credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  // No org row → treat as sufficient (new org, default 100000 credits)
  if (!orgRow) {
    return;
  }

  // Credits > 0 → sufficient for any provider
  if (orgRow.credits > 0) {
    return;
  }

  // Credits <= 0 and VM0 run — insufficient
  if (isVm0) {
    throw insufficientCredits();
  }

  // Effective provider is not VM0 — skip check
}

/**
 * Pre-flight check: ensure the org has a model provider configured.
 * Skips when compose has explicit env vars, an explicit modelProvider param
 * is provided, or the framework doesn't use model providers.
 */
export async function checkModelProviderConfigured(
  orgId: string,
  modelProvider: string | null | undefined,
  composeContent: AgentComposeYaml,
): Promise<void> {
  // Explicit modelProvider param provided — skip (will be validated in build-context)
  if (modelProvider) return;

  // Extract framework and environment from first agent
  const firstAgent = composeContent.agents
    ? Object.values(composeContent.agents)[0]
    : undefined;
  const framework = firstAgent?.framework || "claude-code";

  // Only claude-code framework needs provider resolution
  if (framework !== "claude-code") return;

  // If compose has explicit model provider env vars, skip check
  const hasExplicitConfig = MODEL_PROVIDER_ENV_VARS.some((v) => {
    return firstAgent?.environment?.[v] !== undefined;
  });
  if (hasExplicitConfig) return;

  // Check if org has a default model provider
  const [defaultProvider] = await globalThis.services.db
    .select({ type: modelProviders.type })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.isDefault, true),
      ),
    )
    .limit(1);

  if (!defaultProvider) {
    throw noModelProvider();
  }
}

/**
 * Result of createZeroRunRecord() — contains everything needed by dispatchZeroRun().
 * When the run is enqueued (concurrency limit), dispatch fields are undefined.
 */
interface ZeroRunRecordResult {
  runId: string;
  status: RunStatus;
  createdAt: Date;
  /** Undefined when run was enqueued (concurrency limit) — dispatch already deferred via queue */
  record?: CreateRunRecordResult;
  runParams?: CreateRunParams;
  orgId?: string;
  zeroParams?: ZeroRunParams;
}

/**
 * Create a zero run record with pre-flight checks but without dispatching.
 *
 * Handles agent metadata, compose resolution, org data, pre-flight checks
 * (credits, model provider), and advisory-locked run record creation.
 * Does NOT generate tokens, build execution context, or dispatch to runner.
 *
 * Use dispatchZeroRun() to complete the dispatch pipeline after this returns.
 */
export async function createZeroRunRecord(
  params: ZeroRunParams,
): Promise<ZeroRunRecordResult> {
  const db = globalThis.services.db;

  // Fetch agent metadata (displayName, description, sound, permissionPolicies, orgId)
  const [row] = await db
    .select({
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
      permissionPolicies: zeroAgents.permissionPolicies,
      unknownPermissionPolicies: zeroAgents.unknownPermissionPolicies,
      orgId: zeroAgents.orgId,
      customSkills: zeroAgents.customSkills,
    })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, params.agentId))
    .limit(1);

  const agent: {
    displayName: string | null;
    description: string | null;
    sound: string | null;
    rawPermissionPolicies: FirewallPolicies | null;
    orgId: string | null;
  } = row
    ? {
        displayName: row.displayName,
        description: row.description,
        sound: row.sound,
        rawPermissionPolicies: toFirewallPolicies(
          row.permissionPolicies,
          row.unknownPermissionPolicies,
        ),
        orgId: row.orgId,
      }
    : {
        displayName: null,
        description: null,
        sound: null,
        rawPermissionPolicies: null,
        orgId: null,
      };

  // Fetch connector permissions for this user+agent from user_connectors table.
  // Only connectors explicitly enabled by the user are injected at runtime.
  let allowedConnectorTypes: ConnectorType[] | undefined;
  if (agent.orgId) {
    const permRows = await db
      .select({ connectorType: userConnectors.connectorType })
      .from(userConnectors)
      .where(
        and(
          eq(userConnectors.orgId, agent.orgId),
          eq(userConnectors.userId, params.userId),
          eq(userConnectors.agentId, params.agentId),
        ),
      );
    allowedConnectorTypes = permRows
      .map((r) => {
        return connectorTypeSchema.safeParse(r.connectorType);
      })
      .filter((p) => {
        return p.success;
      })
      .map((p) => {
        return p.data;
      });
  }

  // Resolve permission policies using the user's enabled connectors so that
  // default policies are seeded for each allowed connector type.
  const permissionPolicies = resolveFirewallPolicies(
    agent.rawPermissionPolicies,
    allowedConnectorTypes ?? [],
  );

  // 1. Resolve compose version + org context
  const resolved = await resolveStartRunCompose({
    userId: params.userId,
    prompt: params.prompt,
    composeId: params.agentId,
    sessionId: params.sessionId,
  });
  const orgMeta = await getOrgMetadata(resolved.orgId);
  const orgTier = orgTierSchema.parse(orgMeta.tier);

  // Build agent system prompt: identity + tools + user info, then trigger context
  const agentPrompt = buildAgentPrompt(agent);
  const [cachedUser, userPrefs] = await Promise.all([
    getCachedUser(params.userId),
    getUserPreferences(resolved.orgId, params.userId),
  ]);
  const userInfo = buildUserInfo({
    name: cachedUser.name ?? undefined,
    email: cachedUser.email,
    timezone: userPrefs.timezone || "UTC",
    ...params.userInfoExtras,
  });
  let { appendSystemPrompt } = params;
  const systemParts = [agentPrompt, userInfo];
  const featureOverrides = await loadFeatureSwitchOverrides(
    resolved.orgId,
    params.userId,
  );
  if (
    isFeatureEnabled(FeatureSwitchKey.AutoSkill, {
      orgId: resolved.orgId,
      overrides: featureOverrides,
    })
  ) {
    systemParts.push(buildAutoSkillGuidance());
  }
  if (appendSystemPrompt) {
    systemParts.push(appendSystemPrompt);
  }
  appendSystemPrompt = systemParts.join("\n\n");

  // 2. Construct CreateRunParams (infra knows nothing about ZERO_TOKEN)
  //    Inject custom skill volumes for new runs (session resume inherits from checkpoint).
  const skillVolumes = !params.sessionId
    ? (row?.customSkills ?? []).map((name) => {
        return {
          name: getCustomSkillStorageName(name),
          mountPath: `/home/user/.claude/skills/${name}`,
        };
      })
    : [];

  const runParams: CreateRunParams = {
    userId: params.userId,
    agentComposeVersionId: resolved.agentComposeVersionId,
    prompt: params.prompt,
    composeId: resolved.composeId,
    sessionId: params.sessionId,
    appendSystemPrompt,
    modelProvider: params.modelProvider,
    callbacks: params.callbacks,
    memoryName: "memory",
    disallowedTools: [...DISALLOWED_TOOLS],
    vars: { ZERO_AGENT_ID: params.agentId },
    permissionPolicies: permissionPolicies ?? undefined,
    allowedConnectorTypes,
    agentName: resolved.agentName,
    orgId: resolved.orgId,
    orgTier,
    additionalVolumes: skillVolumes.length > 0 ? skillVolumes : undefined,
  };

  // 3. Pre-flight checks: load compose, authorize, validate, credits, model provider
  const apiStartTime = Date.now();
  const preloadedCompose = await loadCompose(
    resolved.agentComposeVersionId,
    resolved.composeId,
  );
  authorizeCompose(params.userId, resolved.orgId, preloadedCompose.compose);
  const authorizeTime = Date.now();

  if (!params.sessionId) {
    await validateComposeRequirements(preloadedCompose.composeContent);
  }

  await Promise.all([
    checkOrgCredits(resolved.orgId, params.userId, params.modelProvider),
    checkModelProviderConfigured(
      resolved.orgId,
      params.modelProvider,
      preloadedCompose.composeContent,
    ),
  ]);

  // 3b. Check if user has capture-network-bodies quota remaining
  const captureNetworkBodies = await consumeCaptureNetworkBodies(
    resolved.orgId,
    params.userId,
  );
  if (captureNetworkBodies) {
    runParams.captureNetworkBodies = true;
  }

  // 4. Advisory lock + concurrency check + INSERT (zero owns the transaction)
  let run;
  try {
    run = await globalThis.services.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${resolved.orgId}))`,
      );
      await checkRunConcurrencyLimit(resolved.orgId, orgTier, tx);
      return insertRunRecord(tx, runParams);
    });
  } catch (error) {
    if (isConcurrentRunLimit(error)) {
      // Enqueue without token — dispatchQueuedZeroRun generates a fresh
      // token at dispatch time.
      const queueResult = await enqueueRun(runParams);

      // Persist zero-layer metadata
      await persistZeroRunMetadata(queueResult.runId, params);

      return {
        runId: queueResult.runId,
        status: queueResult.status,
        createdAt: queueResult.createdAt,
      };
    }
    throw error;
  }

  const transactionTime = Date.now();

  // Persist zero-layer metadata immediately so that activity queries
  // (LEFT JOIN zero_runs) see the correct triggerSource before dispatch
  // completes. Model fields are updated later in dispatchZeroRun().
  await persistZeroRunMetadata(run.id, params);

  const record: CreateRunRecordResult = {
    run: { id: run.id, createdAt: run.createdAt },
    composeContent: preloadedCompose.composeContent,
    orgId: resolved.orgId,
    apiStartTime,
    authorizeTime,
    transactionTime,
  };

  return {
    runId: run.id,
    status: "pending",
    createdAt: run.createdAt,
    record,
    runParams,
    orgId: resolved.orgId,
    zeroParams: params,
  };
}

/**
 * Dispatch a zero run after its record has been created.
 *
 * Handles callbacks, token generation, execution context building,
 * runner dispatch, and zero-layer metadata persistence.
 * On failure: marks run as failed and drains the org queue.
 *
 * Safe to call from after() — errors are handled internally.
 */
export async function dispatchZeroRun(
  result: ZeroRunRecordResult,
): Promise<{ status: RunStatus; sandboxId?: string } | undefined> {
  const { record, runParams, orgId, zeroParams } = result;

  // Nothing to dispatch if run was enqueued (concurrency limit)
  if (!record || !runParams || !orgId || !zeroParams) return undefined;

  try {
    // 5. Register callbacks early so they persist even if context building fails
    if (runParams.callbacks && runParams.callbacks.length > 0) {
      await registerCallbacks(record.run.id, runParams.callbacks);
    }

    // 6. Generate ZERO_TOKEN + sandbox token (now we have runId)
    const overrides = await loadFeatureSwitchOverrides(
      orgId,
      zeroParams.userId,
    );
    const [zeroToken, sandboxToken] = await Promise.all([
      generateZeroToken(zeroParams.userId, record.run.id, orgId, overrides),
      generateSandboxToken(zeroParams.userId, record.run.id),
    ]);
    const tokenTime = Date.now();

    // 7. Build zero execution context (resolves secrets, model provider, firewalls)
    const paramsWithToken: CreateRunParams = {
      ...runParams,
      secrets: { ...runParams.secrets, ZERO_TOKEN: zeroToken },
    };
    const contextResult = await buildZeroExecutionContext({
      ...paramsWithToken,
      sandboxToken,
      runId: record.run.id,
      agentCompose: record.composeContent,
      agentName: runParams.agentName,
    });

    // 8. Dispatch with pre-built context (callbacks already registered above)
    const dispatchResult = await buildAndDispatchRun({
      runId: record.run.id,
      context: contextResult.context,
      timings: {
        apiStart: record.apiStartTime,
        authorize: record.authorizeTime,
        transaction: record.transactionTime,
        token: tokenTime,
        resolveSourceDuration: contextResult.timings.resolveSourceAndOrg,
        resolveSecretsDuration: contextResult.timings.resolveSecrets,
      },
    });

    // 9. Update zero-layer metadata with model fields resolved during dispatch.
    // The base row (triggerSource, scheduleId, triggerAgentId) was already
    // inserted in createZeroRunRecord; here we only backfill model info.
    if (contextResult?.resolvedModelProvider || contextResult?.selectedModel) {
      await updateZeroRunModelInfo(record.run.id, contextResult);
    }

    return dispatchResult;
  } catch (error) {
    await markRunFailed(record.run.id, error);
    await drainOrgQueue(orgId, dispatchQueuedZeroRun).catch((drainErr) => {
      log.error("Failed to drain org queue after run failure", { drainErr });
    });
    throw error;
  }
}

/**
 * Create an agent run with zero-layer defaults.
 *
 * Composition of createZeroRunRecord() + dispatchZeroRun(). Performs the
 * full synchronous pipeline: pre-flight checks, record creation, token
 * generation, context building, and runner dispatch.
 *
 * All trigger paths except chat messages use this function directly.
 * The chat messages route uses createZeroRunRecord() + after(dispatchZeroRun)
 * to defer the dispatch pipeline and return a response faster.
 */
export async function createZeroRun(
  params: ZeroRunParams,
): Promise<CreateRunResult> {
  const result = await createZeroRunRecord(params);

  // Enqueued runs (concurrency limit) — no dispatch needed
  if (!result.record) {
    return {
      runId: result.runId,
      status: result.status,
      createdAt: result.createdAt,
    };
  }

  const dispatchResult = await dispatchZeroRun(result);

  return {
    runId: result.runId,
    status: dispatchResult?.status ?? "pending",
    sandboxId: dispatchResult?.sandboxId,
    createdAt: result.createdAt,
  };
}

/**
 * Persist zero-layer metadata to zero_runs table.
 * Called eagerly during createZeroRunRecord so that activity queries see the
 * correct triggerSource immediately (before dispatch completes).
 */
async function persistZeroRunMetadata(
  runId: string,
  params: ZeroRunParams,
): Promise<void> {
  await globalThis.services.db.insert(zeroRuns).values({
    id: runId,
    triggerSource: params.triggerSource,
    scheduleId: params.scheduleId ?? null,
    triggerAgentId: params.triggerAgentId ?? null,
    modelProvider: params.modelProvider ?? null,
    selectedModel: null,
  });
}

/**
 * Update model-related fields on an existing zero_runs row.
 * Called during dispatchZeroRun after model resolution.
 */
async function updateZeroRunModelInfo(
  runId: string,
  contextResult: {
    resolvedModelProvider: string | undefined;
    selectedModel: string | undefined;
  },
): Promise<void> {
  await globalThis.services.db
    .update(zeroRuns)
    .set({
      modelProvider: contextResult.resolvedModelProvider ?? undefined,
      selectedModel: contextResult.selectedModel ?? undefined,
    })
    .where(eq(zeroRuns.id, runId));
}
