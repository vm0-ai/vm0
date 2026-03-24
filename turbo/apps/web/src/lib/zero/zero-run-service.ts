import { eq, and } from "drizzle-orm";
import type { TriggerSource, FirewallPolicies } from "@vm0/core";
import { startRun, type CreateRunResult } from "../run";
import { DISALLOWED_CRON_TOOLS } from "../integration-context";
import { formatAgentIdentityPrompt } from "../agent-identity";
import type { CallbackPayload } from "../callback/callback-payloads";
import { zeroAgents } from "../../db/schema/zero-agent";
import { agentComposes } from "../../db/schema/agent-compose";

/**
 * Resolve agent identity metadata and the corresponding composeId
 * from a zeroAgentId. Uses leftJoin so it works even if no matching
 * agentComposes row exists (forward-compatible).
 */
async function resolveZeroAgent(zeroAgentId: string): Promise<{
  displayName: string | null;
  description: string | null;
  sound: string | null;
  composeId: string | null;
  firewallPolicies: FirewallPolicies | null;
}> {
  const [row] = await globalThis.services.db
    .select({
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
      composeId: agentComposes.id,
      firewallPolicies: zeroAgents.firewallPolicies,
    })
    .from(zeroAgents)
    .leftJoin(
      agentComposes,
      and(
        eq(agentComposes.orgId, zeroAgents.orgId),
        eq(agentComposes.name, zeroAgents.name),
      ),
    )
    .where(eq(zeroAgents.id, zeroAgentId))
    .limit(1);

  return (
    row ?? {
      displayName: null,
      description: null,
      sound: null,
      composeId: null,
      firewallPolicies: null,
    }
  );
}

/**
 * Parameters accepted by createZeroRun().
 * All zero trigger paths (web, schedule, telegram, slack, email, github)
 * use this interface to create agent runs with consistent defaults.
 */
interface ZeroRunParams {
  userId: string;
  prompt: string;
  zeroAgentId: string;
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
 * Resolves the agent's composeId internally from zeroAgentId, then injects
 * agent identity, memoryName, artifactName, and disallowedTools so that
 * every zero trigger path gets consistent identity, memory persistence,
 * artifact storage, and cron-tool restrictions.
 */
export async function createZeroRun(
  params: ZeroRunParams,
): Promise<CreateRunResult> {
  const agent = await resolveZeroAgent(params.zeroAgentId);

  // Inject agent identity into appendSystemPrompt
  let { appendSystemPrompt } = params;
  if (agent.displayName || agent.description || agent.sound) {
    const identity = formatAgentIdentityPrompt(agent);
    appendSystemPrompt = appendSystemPrompt
      ? `${identity}\n\n${appendSystemPrompt}`
      : identity;
  }

  return startRun({
    userId: params.userId,
    prompt: params.prompt,
    composeId: agent.composeId ?? undefined,
    triggerSource: params.triggerSource,
    sessionId: params.sessionId,
    appendSystemPrompt,
    modelProvider: params.modelProvider,
    callbacks: params.callbacks,
    scheduleId: params.scheduleId,
    memoryName: "memory",
    artifactName: "artifact",
    disallowedTools: [...DISALLOWED_CRON_TOOLS],
    firewallPolicies: agent.firewallPolicies ?? undefined,
  });
}
