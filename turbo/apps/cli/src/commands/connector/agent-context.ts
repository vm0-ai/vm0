import {
  getAgent,
  getAgentCustomConnectorGrants,
  getAgentUserConnectors,
} from "../../lib/api/domains/agents";
import { getOkouAgentId } from "../../lib/okou-env";

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
  const agentId = flagAgentId ?? getOkouAgentId();
  if (!agentId) return null;

  const [agent, enabledConnectorSlugs] = await Promise.all([
    getAgent(agentId),
    getAgentUserConnectors(agentId),
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
  const agentId = flagAgentId ?? getOkouAgentId();
  if (!agentId) return null;

  const [agent, enabledConnectorSlugs, customConnectorGrants] =
    await Promise.all([
      getAgent(agentId),
      getAgentUserConnectors(agentId),
      getAgentCustomConnectorGrants(agentId),
    ]);

  return {
    agentId: agent.agentId,
    displayName: agent.displayName ?? agent.agentId,
    authorizedConnectorSlugs: new Set(enabledConnectorSlugs),
    authorizedCustomConnectorIds: new Set(
      customConnectorGrants.map((grant) => {
        return grant.customConnectorId;
      }),
    ),
  };
}
