import {
  getZeroAgent,
  getZeroAgentCustomConnectors,
  getZeroAgentUserConnectors,
} from "../../../lib/api";

interface AgentContext {
  agentId: string;
  displayName: string;
  authorizedConnectorSlugs: Set<string>;
}

export interface ConnectorDiscoveryAgentContext extends AgentContext {
  authorizedCustomConnectorIds: Set<string>;
}

export async function resolveAgentContext(
  flagAgentId: string | undefined,
): Promise<AgentContext | null> {
  const agentId = flagAgentId ?? process.env.ZERO_AGENT_ID;
  if (!agentId) return null;

  const [agent, enabledConnectorSlugs] = await Promise.all([
    getZeroAgent(agentId),
    getZeroAgentUserConnectors(agentId),
  ]);

  return {
    agentId: agent.agentId,
    displayName: agent.displayName ?? agent.agentId,
    authorizedConnectorSlugs: new Set(enabledConnectorSlugs),
  };
}

export async function resolveConnectorDiscoveryAgentContext(
  flagAgentId: string | undefined,
): Promise<ConnectorDiscoveryAgentContext | null> {
  const agentId = flagAgentId ?? process.env.ZERO_AGENT_ID;
  if (!agentId) return null;

  const [agent, enabledConnectorSlugs, enabledCustomConnectorIds] =
    await Promise.all([
      getZeroAgent(agentId),
      getZeroAgentUserConnectors(agentId),
      getZeroAgentCustomConnectors(agentId),
    ]);

  return {
    agentId: agent.agentId,
    displayName: agent.displayName ?? agent.agentId,
    authorizedConnectorSlugs: new Set(enabledConnectorSlugs),
    authorizedCustomConnectorIds: new Set(enabledCustomConnectorIds),
  };
}
