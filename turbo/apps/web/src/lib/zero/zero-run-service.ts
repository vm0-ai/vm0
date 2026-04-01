import { eq, and } from "drizzle-orm";
import {
  resolveFirewallPolicies,
  orgTierSchema,
  type TriggerSource,
  type FirewallPolicies,
  type ConnectorType,
  connectorTypeSchema,
} from "@vm0/core";
import {
  createRunRecord,
  buildAndDispatchRun,
  resolveStartRunCompose,
  loadCompose,
  markRunFailed,
  registerCallbacks,
  type CreateRunResult,
  type CreateRunParams,
} from "../run";
import { enqueueRun, drainOrgQueue } from "../run/run-queue-service";
import { generateZeroToken, generateSandboxToken } from "../auth/sandbox-token";
import {
  buildZeroExecutionContext,
  MODEL_PROVIDER_ENV_VARS,
} from "./build-zero-context";
import { getOrgData } from "../org/org-cache-service";
import {
  isConcurrentRunLimit,
  insufficientCredits,
  noModelProvider,
} from "../errors";
import { modelProviders } from "../../db/schema/model-provider";
import { orgMetadata } from "../../db/schema/org-metadata";
import { orgMembersMetadata } from "../../db/schema/org-members-metadata";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";
import type { AgentComposeYaml } from "../../types/agent-compose";
import {
  DISALLOWED_TOOLS,
  buildAgentToolsPrompt,
} from "../integration-context";
import { formatAgentIdentityPrompt } from "../agent-identity";
import type { CallbackPayload } from "../callback/callback-payloads";
import { zeroAgents } from "../../db/schema/zero-agent";
import { zeroRuns } from "../../db/schema/zero-run";
import { dispatchQueuedZeroRun } from "./zero-queue-service";
import { userConnectors } from "../../db/schema/user-connector";

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
  callbacks?: Array<{ url: string; secret: string; payload: CallbackPayload }>;
  scheduleId?: string;
  triggerAgentId?: string;
}

/**
 * Pre-flight check: ensure the org has sufficient credits for VM0 runs.
 * Skips for non-VM0 provider runs. Queries orgMetadata + orgMembersMetadata.
 */
async function checkOrgCredits(
  orgId: string,
  userId: string,
  modelProvider: string | null | undefined,
): Promise<void> {
  const db = globalThis.services.db;

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

  // No org row → treat as sufficient (new org, default 10000 credits)
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
async function checkModelProviderConfigured(
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
 * Create an agent run with zero-layer defaults.
 *
 * agentId is the composeId (single UUID). Fetches agent metadata from
 * zero_agents, then injects agent identity, memoryName, artifactName,
 * and disallowedTools so that every zero trigger path gets consistent
 * identity, memory persistence, artifact storage, and cron-tool restrictions.
 *
 * Pre-flight checks (credits, model provider) run before createRunRecord()
 * so they apply to both direct and queued paths.
 */
export async function createZeroRun(
  params: ZeroRunParams,
): Promise<CreateRunResult> {
  const db = globalThis.services.db;

  // Fetch agent metadata (displayName, description, sound, firewallPolicies, orgId)
  const [row] = await db
    .select({
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
      firewallPolicies: zeroAgents.firewallPolicies,
      orgId: zeroAgents.orgId,
    })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, params.agentId))
    .limit(1);

  const agent: {
    displayName: string | null;
    description: string | null;
    sound: string | null;
    rawFirewallPolicies: FirewallPolicies | null;
    orgId: string | null;
  } = row
    ? {
        displayName: row.displayName,
        description: row.description,
        sound: row.sound,
        rawFirewallPolicies: row.firewallPolicies ?? null,
        orgId: row.orgId,
      }
    : {
        displayName: null,
        description: null,
        sound: null,
        rawFirewallPolicies: null,
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

  // Build agent system prompt: identity + tools first, then trigger context
  const agentParts: string[] = [];
  if (agent.displayName || agent.description || agent.sound) {
    agentParts.push(formatAgentIdentityPrompt(agent));
  }
  agentParts.push(buildAgentToolsPrompt());

  let { appendSystemPrompt } = params;
  const agentPrompt = agentParts.join("\n\n");
  appendSystemPrompt = appendSystemPrompt
    ? `${agentPrompt}\n\n${appendSystemPrompt}`
    : agentPrompt;

  // Resolve firewall policies using the user's enabled connectors so that
  // default policies are seeded for each allowed connector type.
  const firewallPolicies = resolveFirewallPolicies(
    agent.rawFirewallPolicies,
    allowedConnectorTypes ?? [],
  );

  // 1. Resolve compose version + org context
  const resolved = await resolveStartRunCompose({
    userId: params.userId,
    prompt: params.prompt,
    composeId: params.agentId,
    sessionId: params.sessionId,
  });
  const orgData = await getOrgData(resolved.orgId);
  const orgTier = orgTierSchema.parse(orgData.tier);

  // 2. Construct CreateRunParams (infra knows nothing about ZERO_TOKEN)
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
    firewallPolicies: firewallPolicies ?? undefined,
    allowedConnectorTypes,
    agentName: resolved.agentName,
    orgId: resolved.orgId,
    orgTier,
  };

  // 3. Pre-flight checks: credits + model provider (before createRunRecord)
  const { composeContent: preflightCompose } = await loadCompose(
    resolved.agentComposeVersionId,
    resolved.composeId,
  );
  await Promise.all([
    checkOrgCredits(resolved.orgId, params.userId, params.modelProvider),
    checkModelProviderConfigured(
      resolved.orgId,
      params.modelProvider,
      preflightCompose,
    ),
  ]);

  // 4. Create run record (may throw ConcurrentRunLimitError)
  let record;
  try {
    record = await createRunRecord(runParams);
  } catch (error) {
    if (isConcurrentRunLimit(error)) {
      // Enqueue without token — dispatchQueuedZeroRun generates a fresh
      // token at dispatch time.
      const queueResult = await enqueueRun(runParams);

      // Persist zero-layer metadata
      await persistZeroRunMetadata(queueResult.runId, params);

      return queueResult;
    }
    throw error;
  }

  // Steps 5-8 run after createRunRecord — wrap in try-catch so that
  // failures (e.g. session framework mismatch, provider resolution) are
  // recorded against the run and the route handler can return 201 + failed.
  try {
    // 5. Register callbacks early so they persist even if context building fails
    if (runParams.callbacks && runParams.callbacks.length > 0) {
      await registerCallbacks(record.run.id, runParams.callbacks);
    }

    // 6. Generate ZERO_TOKEN + sandbox token (now we have runId)
    const [zeroToken, sandboxToken] = await Promise.all([
      generateZeroToken(params.userId, record.run.id, resolved.orgId),
      generateSandboxToken(params.userId, record.run.id),
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
    const result = await buildAndDispatchRun({
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
      queueDispatcher: dispatchQueuedZeroRun,
    });

    // 9. Persist zero-layer metadata (triggerSource + schedule + trigger agent + model fields)
    await persistZeroRunMetadata(record.run.id, params, contextResult);

    return {
      runId: record.run.id,
      status: result.status,
      sandboxId: result.sandboxId,
      createdAt: record.run.createdAt,
    };
  } catch (error) {
    await markRunFailed(record.run.id, error, () => {
      return drainOrgQueue(resolved.orgId, dispatchQueuedZeroRun);
    });
    throw error;
  }
}

/**
 * Persist zero-layer metadata to zero_runs table.
 * Extracted to keep createZeroRun within complexity limits.
 */
async function persistZeroRunMetadata(
  runId: string,
  params: ZeroRunParams,
  contextResult?: {
    resolvedModelProvider: string | undefined;
    selectedModel: string | undefined;
  },
): Promise<void> {
  await globalThis.services.db.insert(zeroRuns).values({
    id: runId,
    triggerSource: params.triggerSource,
    scheduleId: params.scheduleId ?? null,
    triggerAgentId: params.triggerAgentId ?? null,
    modelProvider:
      contextResult?.resolvedModelProvider ?? params.modelProvider ?? null,
    selectedModel: contextResult?.selectedModel ?? null,
  });
}
