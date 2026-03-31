import { eq } from "drizzle-orm";
import {
  resolveFirewallPolicies,
  orgTierSchema,
  type TriggerSource,
  type FirewallPolicies,
} from "@vm0/core";
import {
  createRunRecord,
  buildAndDispatchRun,
  resolveStartRunCompose,
  type CreateRunResult,
  type CreateRunParams,
} from "../run";
import { enqueueRun } from "../run/run-queue-service";
import { generateZeroToken } from "../auth/sandbox-token";
import { getOrgData } from "../org/org-cache-service";
import { isConcurrentRunLimit } from "../errors";
import {
  DISALLOWED_TOOLS,
  buildAgentToolsPrompt,
} from "../integration-context";
import { formatAgentIdentityPrompt } from "../agent-identity";
import type { CallbackPayload } from "../callback/callback-payloads";
import { zeroAgents } from "../../db/schema/zero-agent";
import { zeroRuns } from "../../db/schema/zero-run";
import { dispatchQueuedZeroRun } from "./zero-queue-service";

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
}

/**
 * Create an agent run with zero-layer defaults.
 *
 * agentId is the composeId (single UUID). Fetches agent metadata from
 * zero_agents, then injects agent identity, memoryName, artifactName,
 * and disallowedTools so that every zero trigger path gets consistent
 * identity, memory persistence, artifact storage, and cron-tool restrictions.
 *
 * Token generation happens between createRunRecord() and buildAndDispatchRun()
 * so that infra never needs to know about ZERO_TOKEN.
 */
export async function createZeroRun(
  params: ZeroRunParams,
): Promise<CreateRunResult> {
  // Fetch agent metadata (displayName, description, sound, firewallPolicies)
  const [row] = await globalThis.services.db
    .select({
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
      connectors: zeroAgents.connectors,
      firewallPolicies: zeroAgents.firewallPolicies,
    })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, params.agentId))
    .limit(1);

  const agent: {
    displayName: string | null;
    description: string | null;
    sound: string | null;
    firewallPolicies: FirewallPolicies | null;
  } = row
    ? {
        displayName: row.displayName,
        description: row.description,
        sound: row.sound,
        firewallPolicies: resolveFirewallPolicies(
          row.firewallPolicies ?? null,
          row.connectors,
        ),
      }
    : {
        displayName: null,
        description: null,
        sound: null,
        firewallPolicies: null,
      };

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
    firewallPolicies: agent.firewallPolicies ?? undefined,
    agentName: resolved.agentName,
    orgId: resolved.orgId,
    orgTier,
  };

  // 3. Create run record (may throw ConcurrentRunLimitError)
  let record;
  try {
    record = await createRunRecord(runParams);
  } catch (error) {
    if (isConcurrentRunLimit(error)) {
      // Enqueue without token — dispatchQueuedZeroRun generates a fresh
      // token at dispatch time.
      const queueResult = await enqueueRun(runParams);

      // Persist zero-layer metadata
      await globalThis.services.db.insert(zeroRuns).values({
        id: queueResult.runId,
        triggerSource: params.triggerSource,
        scheduleId: params.scheduleId ?? null,
      });

      return queueResult;
    }
    throw error;
  }

  // 4. Generate ZERO_TOKEN (now we have runId)
  const zeroToken = await generateZeroToken(
    params.userId,
    record.run.id,
    resolved.orgId,
  );

  // 5. Dispatch with token in secrets
  const result = await buildAndDispatchRun({
    runId: record.run.id,
    createdAt: record.run.createdAt,
    params: {
      ...runParams,
      secrets: { ...runParams.secrets, ZERO_TOKEN: zeroToken },
    },
    composeContent: record.composeContent,
    orgId: record.orgId,
    apiStartTime: record.apiStartTime,
    authorizeTime: record.authorizeTime,
    transactionTime: record.transactionTime,
    queueDispatcher: dispatchQueuedZeroRun,
  });

  // 6. Persist zero-layer metadata (triggerSource + schedule association)
  await globalThis.services.db.insert(zeroRuns).values({
    id: record.run.id,
    triggerSource: params.triggerSource,
    scheduleId: params.scheduleId ?? null,
  });

  return {
    runId: record.run.id,
    status: result.status,
    sandboxId: result.sandboxId,
    createdAt: record.run.createdAt,
  };
}
