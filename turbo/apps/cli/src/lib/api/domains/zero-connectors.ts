import { initClient } from "@ts-rest/core";
import {
  zeroConnectorsMainContract,
  zeroConnectorsByTypeContract,
  zeroConnectorSessionsContract,
  zeroConnectorSessionByIdContract,
  zeroComputerConnectorContract,
  type ConnectorListResponse,
  type ConnectorResponse,
  type ConnectorSessionResponse,
  type ConnectorSessionStatusResponse,
  type ComputerConnectorCreateResponse,
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

/**
 * Delete (disconnect) a connector by type (zero proxy)
 */
export async function deleteZeroConnector(type: ConnectorType): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorsByTypeContract, config);

  const result = await client.delete({
    params: { type },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Connector "${type}" not found`);
}

/**
 * Create a connector session for OAuth device flow (zero proxy)
 */
export async function createZeroConnectorSession(
  type: ConnectorType,
): Promise<ConnectorSessionResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorSessionsContract, config);

  const result = await client.create({
    params: { type },
    body: {},
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to create connector session");
}

/**
 * Get connector session status (zero proxy)
 */
export async function getZeroConnectorSession(
  type: ConnectorType,
  sessionId: string,
): Promise<ConnectorSessionStatusResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorSessionByIdContract, config);

  const result = await client.get({
    params: { type, sessionId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get connector session status");
}

/**
 * Create a computer connector (zero proxy)
 */
export async function createZeroComputerConnector(): Promise<ComputerConnectorCreateResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroComputerConnectorContract, config);

  const result = await client.create({
    body: {},
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to create computer connector");
}

/**
 * Delete (disconnect) a computer connector (zero proxy)
 */
export async function deleteZeroComputerConnector(): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroComputerConnectorContract, config);

  const result = await client.delete({});

  if (result.status === 204) {
    return;
  }

  handleError(result, "Computer connector not found");
}
