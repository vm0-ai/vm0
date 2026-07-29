import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorsBySlugContract,
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
  connectorSlug: string,
): Promise<PublicConnectorCatalogPermissionDetail | null> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorCatalogContract, config);

  const result = await client.permissions({
    params: { connectorRef: connectorSlug },
  });

  if (result.status === 200) {
    if (result.body.permissions.connectorRef !== connectorSlug) {
      throw new Error(
        `Permission metadata connectorRef mismatch: expected ${connectorSlug}, got ${result.body.permissions.connectorRef}`,
      );
    }
    return result.body.permissions;
  }

  if (result.status === 404) {
    return null;
  }

  handleError(
    result,
    `Failed to get connector permission metadata for "${connectorSlug}"`,
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
  connectorSlug: ConnectorSlug,
): Promise<ConnectorResponse | null> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorsBySlugContract, config);

  const result = await client.get({
    params: { type: connectorSlug },
  });

  if (result.status === 200) {
    return result.body;
  }

  if (result.status === 404) {
    return null;
  }

  handleError(result, `Failed to get connector "${connectorSlug}"`);
}

export async function connectZeroConnectorManualGrant(
  connectorSlug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
  values: Record<string, string>,
): Promise<ConnectorResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorManualGrantContract, config);

  const result = await client.connect({
    params: { type: connectorSlug },
    body: { authMethod, values },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to connect connector "${connectorSlug}"`);
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
