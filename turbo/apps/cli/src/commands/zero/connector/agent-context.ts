import { getZeroAgent, getZeroAgentUserConnectors } from "../../../lib/api";

interface AgentContext {
  agentId: string;
  displayName: string;
  authorizedTypes: Set<string>;
}

export async function resolveAgentContext(
  flagAgentId: string | undefined,
): Promise<AgentContext | null> {
  const agentId = flagAgentId ?? process.env.ZERO_AGENT_ID;
  if (!agentId) return null;

  const [agent, enabledTypes] = await Promise.all([
    getZeroAgent(agentId),
    getZeroAgentUserConnectors(agentId),
  ]);

  return {
    agentId: agent.agentId,
    displayName: agent.displayName ?? agent.agentId,
    authorizedTypes: new Set(enabledTypes),
  };
}
