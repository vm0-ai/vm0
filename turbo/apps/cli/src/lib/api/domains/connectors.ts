import { initClient } from "@ts-rest/core";
import {
  connectorsMainContract,
  connectorsByTypeContract,
  type ConnectorType,
  type ConnectorListResponse,
  type ConnectorResponse,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List all connectors for the authenticated user
 */
export async function listConnectors(): Promise<ConnectorListResponse> {
  const config = await getClientConfig();
  const client = initClient(connectorsMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list connectors");
}

/**
 * Delete (disconnect) a connector by type
 */
export async function deleteConnector(type: ConnectorType): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(connectorsByTypeContract, config);

  const result = await client.delete({
    params: { type },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Connector "${type}" not found`);
}

/**
 * Get a connector by type
 * Returns null if not connected (404 response)
 */
export async function getConnector(
  type: ConnectorType,
): Promise<ConnectorResponse | null> {
  const config = await getClientConfig();
  const client = initClient(connectorsByTypeContract, config);

  const result = await client.get({
    params: { type },
  });

  if (result.status === 200) {
    return result.body;
  }

  // 404 means not connected - return null instead of throwing
  if (result.status === 404) {
    return null;
  }

  handleError(result, `Failed to get connector "${type}"`);
}
