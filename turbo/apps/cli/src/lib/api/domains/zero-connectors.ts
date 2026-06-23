import { initClient } from "@ts-rest/core";
import {
  type ConnectorAuthMethodId,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
  zeroConnectorsSearchContract,
  type ConnectorSearchResponse,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorsContract,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type {
  ConnectorListResponse,
  ConnectorResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
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
 * Search available connector definitions for the authenticated user.
 * Omitting the keyword returns the server-side visible connector catalog.
 */
export async function searchZeroConnectors(
  keyword?: string,
): Promise<ConnectorSearchResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorsSearchContract, config);

  const result = await client.search({
    headers: {},
    query: keyword ? { keyword } : {},
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to search connectors");
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

export async function connectZeroConnectorManualGrant(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
  values: Record<string, string>,
): Promise<ConnectorResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorManualGrantContract, config);

  const result = await client.connect({
    params: { type },
    body: { authMethod, values },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to connect connector "${type}"`);
}

export async function listZeroCustomConnectors(): Promise<
  CustomConnectorResponse[]
> {
  const config = await getClientConfig();
  const client = initClient(zeroCustomConnectorsContract, config);

  const result = await client.list({ headers: {} });
  if (result.status === 200) {
    return result.body.connectors;
  }

  handleError(result, "Failed to list custom connectors");
}

export async function getZeroCustomConnector(
  id: string,
): Promise<CustomConnectorResponse | null> {
  const config = await getClientConfig();
  const client = initClient(zeroCustomConnectorByIdContract, config);

  const result = await client.get({ params: { id }, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  if (result.status === 404) {
    return null;
  }

  handleError(result, `Failed to get custom connector "${id}"`);
}
