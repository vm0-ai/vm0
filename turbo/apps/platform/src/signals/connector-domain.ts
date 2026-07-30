import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import type {
  ConnectorListResponse,
  ConnectorProvidedBinding,
  ConnectorResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import type { UserConnectorEnabledSlugs } from "@vm0/api-contracts/contracts/user-connectors";
import type {
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogStatusItem,
  PublicConnectorCatalogStatusResponse,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { UserPermissionGrantResponse } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import type {
  ZeroWorkflowConnectorReadinessEntry,
  ZeroWorkflowConnectorReadinessResponse,
} from "@vm0/api-contracts/contracts/zero-workflows";

export type PlatformConnector = Omit<ConnectorResponse, "type" | "slug"> & {
  readonly slug: ConnectorSlug;
};

type PlatformConnectorProvidedBinding = Omit<
  ConnectorProvidedBinding,
  "connectorType" | "connectorSlug"
> & {
  readonly connectorSlug: ConnectorSlug;
};

type PlatformConnectorListResponse = Omit<
  ConnectorListResponse,
  | "connectors"
  | "configuredTypes"
  | "configuredConnectorSlugs"
  | "connectorProvidedBindings"
> & {
  readonly connectors: readonly PlatformConnector[];
  readonly configuredConnectorSlugs: readonly ConnectorSlug[];
  readonly connectorProvidedBindings: readonly PlatformConnectorProvidedBinding[];
};

type CanonicalCatalogItem<T extends { readonly connectorRef: ConnectorSlug }> =
  Omit<T, "connectorRef" | "slug"> & {
    readonly slug: ConnectorSlug;
  };

export type PlatformConnectorCatalogStatusItem =
  CanonicalCatalogItem<PublicConnectorCatalogStatusItem>;

type PlatformConnectorCatalogStatusResponse = Omit<
  PublicConnectorCatalogStatusResponse,
  "connectors"
> & {
  readonly connectors: readonly PlatformConnectorCatalogStatusItem[];
};

export type PlatformConnectorPermissionMetadata = Omit<
  PublicConnectorCatalogPermissionDetail,
  "connectorRef" | "connectorSlug"
> & {
  readonly connectorSlug: ConnectorSlug;
};

export type PlatformUserPermissionGrant = Omit<
  UserPermissionGrantResponse,
  "connectorRef" | "connectorSlug"
> & {
  readonly connectorSlug: ConnectorSlug;
};

export type PlatformWorkflowConnectorReadinessEntry = Omit<
  ZeroWorkflowConnectorReadinessEntry,
  "connectorRef" | "connectorSlug"
> & {
  readonly connectorSlug: ConnectorSlug;
};

export type PlatformWorkflowConnectorReadinessResponse = Omit<
  ZeroWorkflowConnectorReadinessResponse,
  "connectors"
> & {
  readonly connectors: readonly PlatformWorkflowConnectorReadinessEntry[];
};

function normalizeConnector(connector: ConnectorResponse): PlatformConnector {
  const { type, slug, ...rest } = connector;
  return { ...rest, slug: slug ?? type };
}

function normalizeConnectorProvidedBinding(
  binding: ConnectorProvidedBinding,
): PlatformConnectorProvidedBinding {
  const { connectorType, connectorSlug, ...rest } = binding;
  return { ...rest, connectorSlug: connectorSlug ?? connectorType };
}

export function normalizeConnectorListResponse(
  response: ConnectorListResponse,
): PlatformConnectorListResponse {
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
    connectorProvidedBindings: connectorProvidedBindings.map(
      normalizeConnectorProvidedBinding,
    ),
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

export function normalizeConnectorCatalogStatusResponse(
  response: PublicConnectorCatalogStatusResponse,
): PlatformConnectorCatalogStatusResponse {
  const { connectors, ...rest } = response;
  return {
    ...rest,
    connectors: connectors.map(normalizeCatalogItem),
  };
}

export function normalizeConnectorPermissionMetadata(
  metadata: PublicConnectorCatalogPermissionDetail,
): PlatformConnectorPermissionMetadata {
  const { connectorRef, connectorSlug, ...rest } = metadata;
  return {
    ...rest,
    connectorSlug: connectorSlug ?? connectorRef,
  };
}

export function normalizeEnabledConnectorSlugs(
  response: UserConnectorEnabledSlugs,
): readonly ConnectorSlug[] {
  return response.enabledConnectorSlugs ?? response.enabledTypes;
}

function normalizeUserPermissionGrant(
  grant: UserPermissionGrantResponse,
): PlatformUserPermissionGrant {
  const { connectorRef, connectorSlug, ...rest } = grant;
  return {
    ...rest,
    connectorSlug: connectorSlug ?? connectorRef,
  };
}

export function normalizeUserPermissionGrants(
  grants: readonly UserPermissionGrantResponse[],
): readonly PlatformUserPermissionGrant[] {
  return grants.map(normalizeUserPermissionGrant);
}

export function normalizeWorkflowConnectorReadinessResponse(
  response: ZeroWorkflowConnectorReadinessResponse,
): PlatformWorkflowConnectorReadinessResponse {
  return {
    ...response,
    connectors: response.connectors.map(
      ({ connectorRef, connectorSlug, ...entry }) => {
        return {
          ...entry,
          connectorSlug: connectorSlug ?? connectorRef,
        };
      },
    ),
  };
}
