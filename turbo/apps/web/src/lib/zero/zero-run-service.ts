import { eq, and, sql } from "drizzle-orm";
import { after } from "next/server";
import {
  resolveFirewallPolicies,
  toFirewallPolicies,
  orgTierSchema,
  isFeatureEnabled,
  FeatureSwitchKey,
  getCustomSkillStorageName,
  getSkillStorageName,
  resolveSkillRef,
  parseGitHubTreeUrl,
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
  type CreateRunParams,
  type CreateRunRecordResult,
} from "../infra/run";
import { resolveStartRunCompose } from "./zero-run-validation";
import {
  checkRunConcurrencyLimit,
  authorizeCompose,
  validateComposeRequirements,
  checkOrgCredits,
  checkModelProviderConfigured,
} from "./zero-run-policy";
import {
  enqueueRun,
  drainOrgQueue,
  dispatchQueuedZeroRun,
} from "./zero-run-queue-service";
import { generateZeroToken, generateSandboxToken } from "../auth/sandbox-token";
import { loadFeatureSwitchOverrides } from "./user/feature-switches-service";
import { buildZeroExecutionContext } from "./build-zero-context";
import { getOrgMetadata } from "./org/org-metadata-service";
import { isConcurrentRunLimit } from "../shared/errors";
import {
  DISALLOWED_TOOLS,
  buildAgentPrompt,
  buildAutoSkillGuidance,
} from "./agent-prompt";
import { zeroAgents } from "../../db/schema/zero-agent";
import { zeroRuns } from "../../db/schema/zero-run";
import { userConnectors } from "../../db/schema/user-connector";
import { userCustomConnectors } from "../../db/schema/user-custom-connector";
import {
  consumeCaptureNetworkBodies,
  getUserPreferences,
} from "./user/user-preferences-service";
import { getCachedUser } from "../auth/user-cache-service";
import { buildUserInfo, type UserInfoOptions } from "./integration-prompt";
import { SEED_SKILLS } from "./seed-skills";
import { logger } from "../shared/logger";

const log = logger("service:zero-run");

/**
 * Map user_custom_connectors rows to the `allowedCustomConnectorIds` list.
 * Returns `undefined` when there is no resolved org (non-agent callers like
 * the CLI) so resolveCustomConnectorFirewalls keeps the legacy all-access
 * behavior; returns a (possibly empty) list for agent runs.
 */
function toAllowedCustomConnectorIds(
  orgId: string | null,
  rows: Array<{ customConnectorId: string }>,
): string[] | undefined {
  if (!orgId) {
    return undefined;
  }
  return rows.map((r) => {
    return r.customConnectorId;
  });
}

/**
 * Parameters accepted by createZeroRun().
 * All zero trigger paths (web, schedule, telegram, slack, email, github)
 * use this interface to create agent runs with consistent defaults.
 */
export interface CreateZeroRunParams {
  userId: string;
  prompt: string;
  agentId: string;
  triggerSource: TriggerSource;
  /**
   * Epoch millis captured at the entry point (route handler first line, webhook
   * handler first line, or equivalent). Used as the T_start anchor for startup
   * latency telemetry — the caller owns the clock so the full path from request
   * receipt through pre-flight checks is measured.
   */
  apiStartTime: number;
  sessionId?: string;
  appendSystemPrompt?: string;
  modelProvider?: string;
  /** Per-agent or per-schedule model provider ID override. */
  modelProviderId?: string;
  /** Per-agent or per-schedule selected model override. */
  selectedModelOverride?: string;
  callbacks?: Array<{ url: string; secret: string; payload: unknown }>;
  scheduleId?: string;
  triggerAgentId?: string;
  /** Chat thread this run belongs to (null for non-chat triggers). */
  chatThreadId?: string;
  /** Extra user info fields merged into the base # Current User Info block. */
  userInfoExtras?: UserInfoOptions;
}

/**
 * Result of createZeroRunRecord() — contains everything needed by dispatchZeroRun().
 * When the run is enqueued (concurrency limit), dispatch fields are undefined.
 */
interface ZeroRunRecordResult {
  runId: string;
  status: RunStatus;
  createdAt: Date;
  sessionId: string;
  /** Undefined when run was enqueued (concurrency limit) — dispatch already deferred via queue */
  record?: CreateRunRecordResult;
  runParams?: CreateRunParams;
  orgId?: string;
  zeroParams?: CreateZeroRunParams;
  /** Pre-fetched in Phase 1 — reused in dispatchZeroRun to avoid duplicate DB query */
  featureSwitchOverrides?: Partial<Record<FeatureSwitchKey, boolean>>;
  /** Pre-fetched user timezone in Phase 1 — passed to buildZeroExecutionContext */
  userTimezone?: string;
}

/**
 * Compute system skill additional volumes from SEED_SKILLS plus the per-user
 * authorized connector types. SEED_SKILLS are always injected; connector
 * skills are injected only for connectors the user has authorized for the
 * agent (via the user_connectors table).
 */
function buildSystemSkillVolumes(connectorTypes: readonly string[]): Array<{
  name: string;
  mountPath: string;
  system: boolean;
}> {
  const allSkillNames = [...new Set([...SEED_SKILLS, ...connectorTypes])];
  return allSkillNames.flatMap((skillName) => {
    const url = resolveSkillRef(skillName);
    const parsed = parseGitHubTreeUrl(url);
    if (!parsed) return [];
    return [
      {
        name: getSkillStorageName(parsed.fullPath),
        mountPath: `/home/user/.claude/skills/${parsed.skillName}`,
        system: true,
      },
    ];
  });
}

/**
 * Create a zero run record with pre-flight checks but without dispatching.
 *
 * Handles agent metadata, compose resolution, org data, pre-flight checks
 * (credits, model provider), and advisory-locked run record creation.
 * Does NOT generate tokens, build execution context, or dispatch to runner.
 *
 * Internal to zero-run-service — callers should use createZeroRun().
 */
async function createZeroRunRecord(
  params: CreateZeroRunParams,
): Promise<ZeroRunRecordResult> {
  const db = globalThis.services.db;

  // ── Round 1: Independent operations (need only params) ──────────────
  const [row, resolved, cachedUser] = await Promise.all([
    // Fetch agent metadata (displayName, description, sound, permissionPolicies, orgId)
    db
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
      .limit(1)
      .then(([r]) => {
        return r;
      }),
    // Resolve compose version + org context
    resolveStartRunCompose({
      userId: params.userId,
      prompt: params.prompt,
      composeId: params.agentId,
      sessionId: params.sessionId,
    }),
    // Fetch cached user (only needs userId)
    getCachedUser(params.userId),
  ]);

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

  // ── Round 2: Operations needing agent.orgId or resolved.orgId ───────
  const [
    connectorRows,
    customConnectorRows,
    orgMeta,
    userPrefs,
    featureOverrides,
    preloadedCompose,
  ] = await Promise.all([
    // Fetch connector permissions for this user+agent
    agent.orgId
      ? db
          .select({ connectorType: userConnectors.connectorType })
          .from(userConnectors)
          .where(
            and(
              eq(userConnectors.orgId, agent.orgId),
              eq(userConnectors.userId, params.userId),
              eq(userConnectors.agentId, params.agentId),
            ),
          )
      : Promise.resolve([]),
    // Fetch custom connector authorizations for this user+agent.
    // Parallel to userConnectors but keyed on the org_custom_connectors UUID.
    agent.orgId
      ? db
          .select({
            customConnectorId: userCustomConnectors.customConnectorId,
          })
          .from(userCustomConnectors)
          .where(
            and(
              eq(userCustomConnectors.orgId, agent.orgId),
              eq(userCustomConnectors.userId, params.userId),
              eq(userCustomConnectors.agentId, params.agentId),
            ),
          )
      : Promise.resolve([]),
    // Org metadata (needs resolved.orgId)
    getOrgMetadata(resolved.orgId),
    // User preferences (needs resolved.orgId)
    getUserPreferences(resolved.orgId, params.userId),
    // Feature switch overrides (needs resolved.orgId)
    loadFeatureSwitchOverrides(resolved.orgId, params.userId),
    // Load compose content (needs resolved.agentComposeVersionId)
    loadCompose(resolved.agentComposeVersionId, resolved.composeId),
  ]);

  const orgTier = orgTierSchema.parse(orgMeta.tier);

  // Parse connector types from query results
  const allowedConnectorTypes: ConnectorType[] | undefined = agent.orgId
    ? connectorRows
        .map((r) => {
          return connectorTypeSchema.safeParse(r.connectorType);
        })
        .filter((p) => {
          return p.success;
        })
        .map((p) => {
          return p.data;
        })
    : undefined;

  const allowedCustomConnectorIds = toAllowedCustomConnectorIds(
    agent.orgId,
    customConnectorRows,
  );

  // Resolve permission policies using the user's enabled connectors so that
  // default policies are seeded for each allowed connector type.
  const permissionPolicies = resolveFirewallPolicies(
    agent.rawPermissionPolicies,
    allowedConnectorTypes ?? [],
  );

  // Build agent system prompt: identity + tools + user info, then trigger context
  const agentPrompt = buildAgentPrompt(agent);
  const userInfo = buildUserInfo({
    name: cachedUser.name ?? undefined,
    email: cachedUser.email,
    timezone: userPrefs.timezone || "UTC",
    ...params.userInfoExtras,
  });
  let { appendSystemPrompt } = params;
  const systemParts = [agentPrompt, userInfo];
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

  // Construct CreateRunParams (infra knows nothing about ZERO_TOKEN)
  // Inject system + custom skill volumes (needed on every run).
  const systemSkillVolumes = buildSystemSkillVolumes(
    allowedConnectorTypes ?? [],
  );
  const customSkillVolumes = (row?.customSkills ?? []).map((name) => {
    return {
      name: getCustomSkillStorageName(name),
      mountPath: `/home/user/.claude/skills/${name}`,
    };
  });
  // System skills first, custom skills after (custom overrides system at same mount path)
  const skillVolumes = [...systemSkillVolumes, ...customSkillVolumes];

  const runParams: CreateRunParams = {
    userId: params.userId,
    agentComposeVersionId: resolved.agentComposeVersionId,
    prompt: params.prompt,
    composeId: preloadedCompose.compose.id,
    sessionId: params.sessionId,
    appendSystemPrompt,
    modelProvider: params.modelProvider,
    modelProviderId: params.modelProviderId,
    selectedModelOverride: params.selectedModelOverride,
    callbacks: params.callbacks,
    memoryName: "memory",
    disallowedTools: [...DISALLOWED_TOOLS],
    vars: { ZERO_AGENT_ID: params.agentId },
    permissionPolicies: permissionPolicies ?? undefined,
    allowedConnectorTypes,
    allowedCustomConnectorIds,
    agentName: resolved.agentName,
    orgId: resolved.orgId,
    orgTier,
    additionalVolumes: skillVolumes.length > 0 ? skillVolumes : undefined,
  };

  // ── Round 3: Pre-flight checks (need compose content) ───────────────
  const apiStartTime = params.apiStartTime;
  authorizeCompose(params.userId, resolved.orgId, preloadedCompose.compose);
  const authorizeTime = Date.now();

  if (!params.sessionId) {
    await validateComposeRequirements(preloadedCompose.composeContent);
  }

  const [, , captureNetworkBodies] = await Promise.all([
    checkOrgCredits(resolved.orgId, params.userId, params.modelProvider),
    checkModelProviderConfigured(
      resolved.orgId,
      params.modelProvider,
      preloadedCompose.composeContent,
    ),
    consumeCaptureNetworkBodies(resolved.orgId, params.userId),
  ]);
  if (captureNetworkBodies) {
    runParams.captureNetworkBodies = true;
  }

  // ── Round 4: Advisory lock + concurrency check + INSERT ─────────────
  let run;
  try {
    run = await globalThis.services.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${resolved.orgId}))`,
      );
      await checkRunConcurrencyLimit(resolved.orgId, orgTier, tx);
      return insertRunRecord(tx, {
        userId: runParams.userId,
        orgId: resolved.orgId,
        agentComposeId: preloadedCompose.compose.id,
        agentComposeVersionId: runParams.agentComposeVersionId,
        prompt: runParams.prompt,
        appendSystemPrompt: runParams.appendSystemPrompt,
        vars: runParams.vars,
        secrets: runParams.secrets,
        additionalVolumes: runParams.additionalVolumes,
        resumedFromCheckpointId: runParams.resumedFromCheckpointId,
        sessionId: runParams.sessionId,
        artifactName: runParams.artifactName,
        memoryName: runParams.memoryName,
      });
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
        sessionId: queueResult.sessionId,
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
    sessionId: run.sessionId,
    record,
    runParams,
    orgId: resolved.orgId,
    zeroParams: params,
    featureSwitchOverrides: featureOverrides,
    userTimezone: userPrefs.timezone ?? undefined,
  };
}

/**
 * Dispatch a zero run after its record has been created.
 *
 * Handles callbacks, token generation, execution context building,
 * runner dispatch, and zero-layer metadata persistence.
 * On failure: marks run as failed and drains the org queue.
 *
 * Internal to zero-run-service — scheduled via after() inside createZeroRun().
 */
async function dispatchZeroRun(
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
    // Use pre-fetched featureSwitchOverrides from Phase 1 to avoid duplicate DB query
    const overrides = result.featureSwitchOverrides;
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
      preloadedUserTimezone: result.userTimezone,
      apiStartTime: record.apiStartTime,
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
    // drainOrgQueue always publishes queue:changed in its finally block —
    // including the empty-queue case — so no explicit publish is needed here.
    await drainOrgQueue(orgId, dispatchQueuedZeroRun).catch((drainErr) => {
      log.error("Failed to drain org queue after run failure", { drainErr });
    });
    throw error;
  }
}

/**
 * Public result of createZeroRun().
 *
 * Only fields populated by Phase 1 (pre-flight + INSERT) are exposed; Phase 2
 * (tokens, context, dispatch) runs deferred inside after() so its outputs
 * (sandboxId, final dispatched status) are not available at return time.
 *
 * `status` reflects Phase 1 state only — it is always `"pending"` (record
 * inserted, dispatch scheduled via after()) or `"queued"` (concurrency limit,
 * will be dispatched by the queue worker). It is NEVER a post-dispatch status.
 */
export interface CreateZeroRunResult {
  runId: string;
  status: RunStatus;
  createdAt: Date;
  sessionId: string;
}

/**
 * Create an agent run with zero-layer defaults.
 *
 * Phase 1 (pre-flight checks + advisory-locked INSERT) runs synchronously and
 * is awaited by the caller. Phase 2 (token generation, context building,
 * runner dispatch) is deferred via Next.js after() so the caller's response
 * flushes before the heavy dispatch pipeline runs.
 *
 * Dispatch failures are caught inside the after() callback, logged, and
 * persisted on the run row via markRunFailed() inside dispatchZeroRun.
 */
export async function createZeroRun(
  params: CreateZeroRunParams,
): Promise<CreateZeroRunResult> {
  const result = await createZeroRunRecord(params);

  // Dispatch only when a record was actually inserted; enqueued runs
  // (concurrency limit) are drained by the queue worker later.
  if (result.record) {
    after(() => {
      return dispatchZeroRun(result).catch((err: unknown) => {
        log.error("Deferred dispatch failed", {
          runId: result.runId,
          err,
        });
      });
    });
  }

  return {
    runId: result.runId,
    status: result.status,
    createdAt: result.createdAt,
    sessionId: result.sessionId,
  };
}

/**
 * Persist zero-layer metadata to zero_runs table.
 * Called eagerly during createZeroRunRecord so that activity queries see the
 * correct triggerSource immediately (before dispatch completes).
 */
async function persistZeroRunMetadata(
  runId: string,
  params: CreateZeroRunParams,
): Promise<void> {
  await globalThis.services.db.insert(zeroRuns).values({
    id: runId,
    triggerSource: params.triggerSource,
    scheduleId: params.scheduleId ?? null,
    triggerAgentId: params.triggerAgentId ?? null,
    chatThreadId: params.chatThreadId ?? null,
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
