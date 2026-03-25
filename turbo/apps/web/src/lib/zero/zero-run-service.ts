import { eq } from "drizzle-orm";
import type { TriggerSource, FirewallPolicies } from "@vm0/core";
import { startRun, type CreateRunResult } from "../run";
import {
  DISALLOWED_CRON_TOOLS,
  buildZeroCliGuidance,
} from "../integration-context";
import { formatAgentIdentityPrompt } from "../agent-identity";
import type { CallbackPayload } from "../callback/callback-payloads";
import { zeroAgents } from "../../db/schema/zero-agent";

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
  } = row ?? {
    displayName: null,
    description: null,
    sound: null,
    firewallPolicies: null,
  };

  // Inject agent identity into appendSystemPrompt
  let { appendSystemPrompt } = params;
  if (agent.displayName || agent.description || agent.sound) {
    const identity = formatAgentIdentityPrompt(agent);
    appendSystemPrompt = appendSystemPrompt
      ? `${identity}\n\n${appendSystemPrompt}`
      : identity;
  }

  // Append zero CLI guidance so all trigger paths know how to use the CLI
  const zeroGuidance = buildZeroCliGuidance();
  appendSystemPrompt = appendSystemPrompt
    ? `${appendSystemPrompt}\n\n${zeroGuidance}`
    : zeroGuidance;

  return startRun({
    userId: params.userId,
    prompt: params.prompt,
    composeId: params.agentId,
    triggerSource: params.triggerSource,
    sessionId: params.sessionId,
    appendSystemPrompt,
    modelProvider: params.modelProvider,
    callbacks: params.callbacks,
    scheduleId: params.scheduleId,
    memoryName: "memory",
    artifactName: "artifact",
    disallowedTools: [...DISALLOWED_CRON_TOOLS],
    vars: { ZERO_AGENT_ID: params.agentId },
    firewallPolicies: agent.firewallPolicies ?? undefined,
    injectZeroToken: true,
  });
}
