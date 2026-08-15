import type { McpConnector } from "@okouai/api-contracts/contracts/mcp-connectors";

import { listZeroRunMcpConnectors } from "../../../lib/api/domains/zero-connectors";

export function listRunMcpConnectors(): Promise<McpConnector[]> {
  return listZeroRunMcpConnectors();
}

export async function resolveRunMcpConnector(
  connectorSlug: string,
): Promise<McpConnector> {
  const connectors = await listRunMcpConnectors();
  const connector = connectors.find((candidate) => {
    return candidate.slug === connectorSlug;
  });
  if (!connector) {
    throw new Error(
      `MCP connector "${connectorSlug}" is not authorized for this Agent`,
    );
  }
  return connector;
}
