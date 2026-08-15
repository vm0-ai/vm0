import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorsBySlugContract,
  zeroConnectorsMainContract,
} from "@okouai/api-contracts/contracts/zero-connectors";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogListResponse,
  type PublicConnectorCatalogPermissionDetail,
  type PublicConnectorCatalogStatusItem,
  type PublicConnectorCatalogStatusResponse,
} from "@okouai/api-contracts/contracts/zero-connector-catalog";
import {
  connectorCheckContract,
  type ConnectorCheckDiagnosticResult,
  type ConnectorCheckRequest,
} from "@okouai/api-contracts/contracts/connector-check";
import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorsContract,
  customConnectorListResponseSchema,
  customConnectorResponseSchema,
  type CreateCustomConnectorBody,
  type CustomConnectorResponse,
  type UpdateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/zero-custom-connectors";
import {
  mcpConnectorListResponseSchema,
  mcpConnectorsContract,
  type McpConnector,
} from "@okouai/api-contracts/contracts/mcp-connectors";
import type {
  ConnectorListResponse,
  ConnectorResponse,
} from "@okouai/api-contracts/contracts/connector-schemas";
import { getClientConfig, handleError } from "../core/client-factory";

export type ZeroConnector = ConnectorResponse;
type ZeroConnectorListResponse = ConnectorListResponse;
export type ZeroConnectorCatalogItem =
  PublicConnectorCatalogListResponse["connectors"][number];
export type ZeroConnectorCatalogStatus = PublicConnectorCatalogStatusItem;
type ZeroConnectorCatalogListResponse = PublicConnectorCatalogListResponse;
type ZeroConnectorCatalogStatusResponse = PublicConnectorCatalogStatusResponse;
export type ZeroConnectorCatalogPermissionDetail =
  PublicConnectorCatalogPermissionDetail;

/**
 * List all connectors for the authenticated user (zero proxy)
 */
export async function listZeroConnectors(): Promise<ZeroConnectorListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorsMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list connectors");
}

export async function listZeroConnectorCatalog(): Promise<ZeroConnectorCatalogListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorCatalogContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list connector catalog");
}

export async function listZeroConnectorCatalogStatus(): Promise<ZeroConnectorCatalogStatusResponse> {
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
): Promise<ZeroConnectorCatalogPermissionDetail | null> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorCatalogContract, config);

  const result = await client.permissions({
    params: { connectorSlug },
  });

  if (result.status === 200) {
    const permissions = result.body.permissions;
    if (permissions.connectorSlug !== connectorSlug) {
      throw new Error(
        `Permission metadata connector slug mismatch: expected ${connectorSlug}, got ${permissions.connectorSlug}`,
      );
    }
    return permissions;
  }

  if (result.status === 404) {
    return null;
  }

  handleError(
    result,
    `Failed to get connector permission metadata for "${connectorSlug}"`,
  );
}

export async function diagnoseConnectorCheck(
  request: ConnectorCheckRequest,
): Promise<ConnectorCheckDiagnosticResult> {
  const config = await getClientConfig();
  const client = initClient(connectorCheckContract, {
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
 * Get a connector by slug (zero proxy)
 * Returns null if not connected (404 response)
 */
export async function getZeroConnector(
  connectorSlug: ConnectorSlug,
): Promise<ZeroConnector | null> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorsBySlugContract, config);

  const result = await client.get({
    params: { connectorSlug },
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
): Promise<ZeroConnector> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorManualGrantContract, config);

  const result = await client.connect({
    params: { connectorSlug },
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
    return customConnectorListResponseSchema.parse(result.body).connectors;
  }

  handleError(result, "Failed to list custom connectors");
}

export async function listZeroRunMcpConnectors(): Promise<McpConnector[]> {
  const config = await getClientConfig();
  const client = initClient(mcpConnectorsContract, config);

  const result = await client.list({ headers: {} });
  if (result.status === 200) {
    return mcpConnectorListResponseSchema.parse(result.body).connectors;
  }

  handleError(result, "Failed to list MCP connectors for this run");
}

export async function createZeroCustomConnector(
  body: CreateCustomConnectorBody,
): Promise<CustomConnectorResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroCustomConnectorsContract, config);

  const result = await client.create({ body, headers: {} });
  if (result.status === 201) {
    return customConnectorResponseSchema.parse(result.body);
  }

  handleError(result, "Failed to create custom connector");
}

export async function getZeroCustomConnector(
  id: string,
): Promise<CustomConnectorResponse | null> {
  const config = await getClientConfig();
  const client = initClient(zeroCustomConnectorByIdContract, config);

  const result = await client.get({ params: { id }, headers: {} });
  if (result.status === 200) {
    return customConnectorResponseSchema.parse(result.body);
  }
  if (result.status === 404) {
    return null;
  }

  handleError(result, `Failed to get custom connector "${id}"`);
}

export async function updateZeroCustomConnector(
  id: string,
  body: UpdateCustomConnectorBody,
): Promise<CustomConnectorResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroCustomConnectorByIdContract, config);

  const result = await client.update({ params: { id }, body, headers: {} });
  if (result.status === 200) {
    return customConnectorResponseSchema.parse(result.body);
  }

  handleError(result, `Failed to update custom connector "${id}"`);
}
