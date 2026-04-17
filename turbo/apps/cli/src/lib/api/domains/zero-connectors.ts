import { initClient } from "@ts-rest/core";
import {
  zeroConnectorsMainContract,
  zeroConnectorsByTypeContract,
  type ConnectorListResponse,
  type ConnectorResponse,
  type ConnectorType,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List all connectors for the authenticated user (zero proxy)
 */
export async function listZeroConnectors(): Promise<ConnectorListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorsMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list connectors");
}

/**
 * Get a connector by type (zero proxy)
 * Returns null if not connected (404 response)
 */
export async function getZeroConnector(
  type: ConnectorType,
): Promise<ConnectorResponse | null> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorsByTypeContract, config);

  const result = await client.get({
    params: { type },
  });

  if (result.status === 200) {
    return result.body;
  }

  if (result.status === 404) {
    return null;
  }

  handleError(result, `Failed to get connector "${type}"`);
}
