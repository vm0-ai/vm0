import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import type {
  ConnectorAuthMethodId,
  ConnectorRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogListResponse,
  type PublicConnectorCatalogPermissionDetail,
  type PublicConnectorCatalogStatusResponse,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  zeroConnectorCheckContract,
  type ConnectorCheckDiagnosticResult,
  type ConnectorCheckRequest,
} from "@vm0/api-contracts/contracts/zero-connector-check";
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

export async function listZeroConnectorCatalog(): Promise<PublicConnectorCatalogListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorCatalogContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list connector catalog");
}

export async function listZeroConnectorCatalogStatus(): Promise<PublicConnectorCatalogStatusResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorCatalogContract, config);

  const result = await client.status({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list connector catalog status");
}

export async function getZeroConnectorCatalogPermissions(
  connectorRef: string,
): Promise<PublicConnectorCatalogPermissionDetail | null> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorCatalogContract, config);

  const result = await client.permissions({
    params: { connectorRef },
  });

  if (result.status === 200) {
    if (result.body.permissions.connectorRef !== connectorRef) {
      throw new Error(
        `Permission metadata connectorRef mismatch: expected ${connectorRef}, got ${result.body.permissions.connectorRef}`,
      );
    }
    return result.body.permissions;
  }

  if (result.status === 404) {
    return null;
  }

  handleError(
    result,
    `Failed to get connector permission metadata for "${connectorRef}"`,
  );
}

export async function diagnoseZeroConnectorCheck(
  request: ConnectorCheckRequest,
): Promise<ConnectorCheckDiagnosticResult> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorCheckContract, {
    ...config,
    validateResponse: true,
  });

  const result = await client.check({ body: request });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to diagnose connector");
}

/**
 * Get a connector by type (zero proxy)
 * Returns null if not connected (404 response)
 */
export async function getZeroConnector(
  type: ConnectorRef,
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
  type: ConnectorRef,
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
