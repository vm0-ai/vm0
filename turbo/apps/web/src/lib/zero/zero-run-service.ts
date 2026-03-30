import { eq } from "drizzle-orm";
import {
  resolveFirewallPolicies,
  type TriggerSource,
  type FirewallPolicies,
} from "@vm0/core";
import { startRun, type CreateRunResult } from "../run";
import {
  DISALLOWED_TOOLS,
  buildAgentToolsPrompt,
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
    disallowedTools: [...DISALLOWED_TOOLS],
    vars: { ZERO_AGENT_ID: params.agentId },
    firewallPolicies: agent.firewallPolicies ?? undefined,
    injectZeroToken: true,
  });
}
