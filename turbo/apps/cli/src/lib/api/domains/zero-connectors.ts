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
  type PublicConnectorCatalogStatusItem,
  type PublicConnectorCatalogStatusResponse,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  zeroConnectorCheckContract,
  type ConnectorCheckDiagnosticResult,
  type ConnectorCheckRequest,
} from "@vm0/api-contracts/contracts/zero-connector-check";
import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorOAuth2Contract,
  zeroCustomConnectorValuesContract,
  zeroCustomConnectorsContract,
  type CreateCustomConnectorBody,
  type CustomConnectorValueInput,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type {
  ConnectorProvidedBinding,
  ConnectorListResponse,
  ConnectorResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import { getClientConfig, handleError } from "../core/client-factory";

export type ZeroConnector = Omit<ConnectorResponse, "type" | "slug"> & {
  readonly slug: ConnectorSlug;
};

type ZeroConnectorProvidedBinding = Omit<
  ConnectorProvidedBinding,
  "connectorType" | "connectorSlug"
> & {
  readonly connectorSlug: ConnectorSlug;
};

type ZeroConnectorListResponse = Omit<
  ConnectorListResponse,
  | "connectors"
  | "configuredTypes"
  | "configuredConnectorSlugs"
  | "connectorProvidedBindings"
> & {
  readonly connectors: readonly ZeroConnector[];
  readonly configuredConnectorSlugs: readonly ConnectorSlug[];
  readonly connectorProvidedBindings: readonly ZeroConnectorProvidedBinding[];
};

type CanonicalCatalogItem<T extends { readonly connectorRef: ConnectorSlug }> =
  Omit<T, "connectorRef" | "slug"> & {
    readonly slug: ConnectorSlug;
  };

export type ZeroConnectorCatalogItem = CanonicalCatalogItem<
  PublicConnectorCatalogListResponse["connectors"][number]
>;

export type ZeroConnectorCatalogStatus =
  CanonicalCatalogItem<PublicConnectorCatalogStatusItem>;

type ZeroConnectorCatalogListResponse = Omit<
  PublicConnectorCatalogListResponse,
  "connectors"
> & {
  readonly connectors: readonly ZeroConnectorCatalogItem[];
};

type ZeroConnectorCatalogStatusResponse = Omit<
  PublicConnectorCatalogStatusResponse,
  "connectors"
> & {
  readonly connectors: readonly ZeroConnectorCatalogStatus[];
};

export type ZeroConnectorCatalogPermissionDetail = Omit<
  PublicConnectorCatalogPermissionDetail,
  "connectorRef" | "connectorSlug"
> & {
  readonly connectorSlug: ConnectorSlug;
};

interface RawCheckIdentity {
  readonly connectorRef: ConnectorSlug;
  readonly connectorSlug?: ConnectorSlug;
}

type ZeroCheckIdentity<T extends RawCheckIdentity> = Omit<
  T,
  "connectorRef" | "connectorSlug"
> & {
  readonly connectorSlug: ConnectorSlug;
};

type ZeroConnectorCheckResult<T> = T extends {
  readonly connector: infer Identity extends RawCheckIdentity;
}
  ? Omit<T, "connector"> & {
      readonly connector: ZeroCheckIdentity<Identity>;
    }
  : T extends {
        readonly candidates: infer Candidates extends
          readonly RawCheckIdentity[];
      }
    ? Omit<T, "candidates"> & {
        readonly candidates: {
          readonly [Index in keyof Candidates]: ZeroCheckIdentity<
            Candidates[Index]
          >;
        };
      }
    : T;

export type ZeroConnectorCheckDiagnosticResult =
  ZeroConnectorCheckResult<ConnectorCheckDiagnosticResult>;

function normalizeConnector(connector: ConnectorResponse): ZeroConnector {
  const { type, slug, ...rest } = connector;
  return { ...rest, slug: slug ?? type };
}

function normalizeBinding(
  binding: ConnectorProvidedBinding,
): ZeroConnectorProvidedBinding {
  const { connectorType, connectorSlug, ...rest } = binding;
  return { ...rest, connectorSlug: connectorSlug ?? connectorType };
}

function normalizeConnectorList(
  response: ConnectorListResponse,
): ZeroConnectorListResponse {
  const {
    connectors,
    configuredTypes,
    configuredConnectorSlugs,
    connectorProvidedBindings,
    ...rest
  } = response;
  return {
    ...rest,
    connectors: connectors.map(normalizeConnector),
    configuredConnectorSlugs: configuredConnectorSlugs ?? configuredTypes,
    connectorProvidedBindings: connectorProvidedBindings.map(normalizeBinding),
  };
}

function normalizeCatalogItem<
  T extends {
    readonly connectorRef: ConnectorSlug;
    readonly slug?: ConnectorSlug;
  },
>(connector: T): CanonicalCatalogItem<T> {
  const { connectorRef, slug, ...rest } = connector;
  return { ...rest, slug: slug ?? connectorRef };
}

function normalizeCheckIdentity<T extends RawCheckIdentity>(
  identity: T,
): ZeroCheckIdentity<T> {
  const { connectorRef, connectorSlug, ...rest } = identity;
  return { ...rest, connectorSlug: connectorSlug ?? connectorRef };
}

function normalizeConnectorCheck(
  result: ConnectorCheckDiagnosticResult,
): ZeroConnectorCheckDiagnosticResult {
  switch (result.outcome) {
    case "resolved":
    case "connector-mismatch":
    case "environment-not-owned":
    case "environment-not-used":
    case "unresolved-dynamic-base":
      return { ...result, connector: normalizeCheckIdentity(result.connector) };
    case "ambiguous":
      return {
        ...result,
        candidates: result.candidates.map(normalizeCheckIdentity),
      };
    case "unsafe-input":
    case "unknown-connector":
    case "unknown-environment":
    case "no-match":
    case "run-context-unavailable":
      return result;
  }
}

/**
 * List all connectors for the authenticated user (zero proxy)
 */
export async function listZeroConnectors(): Promise<ZeroConnectorListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorsMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return normalizeConnectorList(result.body);
  }

  handleError(result, "Failed to list connectors");
}

export async function listZeroConnectorCatalog(): Promise<ZeroConnectorCatalogListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorCatalogContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    const { connectors, ...response } = result.body;
    return {
      ...response,
      connectors: connectors.map(normalizeCatalogItem),
    };
  }

  handleError(result, "Failed to list connector catalog");
}

export async function listZeroConnectorCatalogStatus(): Promise<ZeroConnectorCatalogStatusResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorCatalogContract, config);

  const result = await client.status({ headers: {} });

  if (result.status === 200) {
    const { connectors, ...response } = result.body;
    return {
      ...response,
      connectors: connectors.map(normalizeCatalogItem),
    };
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
    const {
      connectorRef,
      connectorSlug: canonicalSlug,
      ...permissions
    } = result.body.permissions;
    const normalizedConnectorSlug = canonicalSlug ?? connectorRef;
    if (normalizedConnectorSlug !== connectorSlug) {
      throw new Error(
        `Permission metadata connector slug mismatch: expected ${connectorSlug}, got ${normalizedConnectorSlug}`,
      );
    }
    return { ...permissions, connectorSlug: normalizedConnectorSlug };
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
): Promise<ZeroConnectorCheckDiagnosticResult> {
  const config = await getClientConfig();
  const client = initClient(zeroConnectorCheckContract, {
    ...config,
    validateResponse: true,
  });

  const result = await client.check({ body: request });

  if (result.status === 200) {
    return normalizeConnectorCheck(result.body);
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
    return normalizeConnector(result.body);
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
    return normalizeConnector(result.body);
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

export async function createZeroCustomConnector(
  body: CreateCustomConnectorBody,
): Promise<CustomConnectorResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroCustomConnectorsContract, config);

  const result = await client.create({ body, headers: {} });
  if (result.status === 201) {
    return result.body;
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
    return result.body;
  }
  if (result.status === 404) {
    return null;
  }

  handleError(result, `Failed to get custom connector "${id}"`);
}

export async function setZeroCustomConnectorValues(
  id: string,
  values: readonly CustomConnectorValueInput[],
): Promise<CustomConnectorResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroCustomConnectorValuesContract, config);

  const result = await client.set({
    params: { id },
    headers: {},
    body: { values: [...values] },
  });
  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Failed to set values for custom connector "${id}"`);
}

export async function startZeroCustomConnectorOAuth2(
  id: string,
  agentId: string | undefined,
): Promise<string> {
  const config = await getClientConfig();
  const client = initClient(zeroCustomConnectorOAuth2Contract, config);

  const result = await client.start({
    params: { id },
    headers: {},
    body: agentId ? { agentId } : {},
  });
  if (result.status === 200) {
    return result.body.authorizationUrl;
  }

  handleError(result, `Failed to start OAuth for custom connector "${id}"`);
}
