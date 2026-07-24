import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogAuthMethodSummary,
  PublicConnectorCatalogConnection,
  PublicConnectorCatalogConnectionStatus,
  PublicConnectorCatalogDetail,
  PublicConnectorCatalogIcon,
  PublicConnectorCatalogItem,
  PublicConnectorCatalogListResponse,
  PublicConnectorCatalogManualField,
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogPermissionSummary,
  PublicConnectorCatalogStartOption,
  PublicConnectorCatalogStatusItem,
  PublicConnectorCatalogStatusResponse,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import type { ConnectorSearchItem } from "@vm0/api-contracts/contracts/zero-connectors";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  connectorDisplayCategoryMetadataForItems,
  type ConnectorAuthMethodConfig,
  type ConnectorRegistryAuthMethodId,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  getAvailableConnectorAuthMethodIds,
  getConfiguredConnectorAuthMethodIds,
  getConnectorAuthMethodAccessMetadata,
  getConnectorAuthMethod,
  getConnectorPrivateNames,
  getConnectorGenerationTypes,
  getConnectorTags,
  hasRequiredConnectorAuthMethodScopes,
  type ApiAuthMethodPolicy,
  type ConnectorFeatureStates,
} from "@vm0/connectors/connector-utils";
import { getStaticConnectorIconMetadata } from "@vm0/connectors/static-connector-icons";
import {
  getFirewallPermissionSummary,
  loadFirewallPermissionMetadata,
} from "@vm0/connectors/firewall-metadata";
import { isExternalConnectorCatalogEnabled } from "../../lib/connector-catalog-source-selection";
import type { ReadonlyDb } from "../external/db";
import {
  getPublicDeviceAuthStartOptionDescriptors,
  getPublicManualGrantFieldDescriptors,
} from "./connector-catalog-form-fields.service";
import {
  ExternalConnectorCatalogUnavailableError,
  getExternalPublicConnectorCatalogDetail,
  getExternalPublicConnectorCatalogPermissionDetail,
  listExternalPublicConnectorCatalog,
  listExternalPublicConnectorCatalogStatus,
  searchExternalConnectorCatalog,
  type ConnectorCatalogReferenceMetadata,
  type ConnectorCatalogStatusRead,
  type ExternalConnectorCatalogRead,
} from "./connector-catalog-external-reader.service";

export function isConnectorCatalogUnavailableError(error: unknown): boolean {
  return error instanceof ExternalConnectorCatalogUnavailableError;
}

interface StaticConnectorCatalogReadArgs {
  readonly featureStates: ConnectorFeatureStates;
  readonly apiAuthMethodPolicy?: ApiAuthMethodPolicy;
}

interface ConnectorCatalogReadArgs extends StaticConnectorCatalogReadArgs {
  readonly db: ReadonlyDb;
}

interface ConnectorCatalogSearchArgs extends ConnectorCatalogReadArgs {
  readonly keyword: string | undefined;
}

interface ConnectorCatalogConnectorReadArgs extends ConnectorCatalogReadArgs {
  readonly connectorRef: string;
}

function isConnectorType(connectorRef: string): connectorRef is ConnectorType {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_TYPES, connectorRef);
}

function getStaticPublicConnectorCatalogIcon(
  connectorRef: ConnectorType,
): PublicConnectorCatalogIcon {
  return getStaticConnectorIconMetadata(connectorRef);
}

function listStaticConnectorCatalogReferenceMetadata(
  connectorRefs: readonly string[],
): readonly ConnectorCatalogReferenceMetadata[] {
  const requestedRefs = new Set(connectorRefs);
  return CONNECTOR_TYPE_KEYS.flatMap((connectorRef) => {
    return requestedRefs.has(connectorRef)
      ? [
          {
            connectorRef,
            label: CONNECTOR_TYPES[connectorRef].label,
            icon: getStaticPublicConnectorCatalogIcon(connectorRef),
          },
        ]
      : [];
  });
}

function availableAuthMethodsForCatalog(
  type: ConnectorType,
  args: StaticConnectorCatalogReadArgs,
): ConnectorRegistryAuthMethodId[] {
  return getAvailableConnectorAuthMethodIds(type, args.featureStates, {
    apiAuthMethodPolicy: args.apiAuthMethodPolicy ?? "include",
  });
}

function permissionSummaryForCatalog(
  type: ConnectorType,
): PublicConnectorCatalogPermissionSummary {
  const summary = getFirewallPermissionSummary(type);
  return {
    hasPermissions: summary?.hasPermissions ?? false,
    permissionCount: summary?.permissionCount ?? 0,
    hasCategories: summary?.hasCategories ?? false,
    hasDefaultPolicyOverrides: summary?.hasDefaultPolicyOverrides ?? false,
  };
}

function normalizePublicText(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function publicTextOrNull(
  value: string | undefined,
  privateNames: ReadonlySet<string>,
  options: { readonly checkDerivedPrivateNames?: boolean } = {},
): string | null {
  if (!value) {
    return null;
  }

  const normalizedValue = normalizePublicText(value);
  for (const privateName of privateNames) {
    const normalizedPrivateName = normalizePublicText(privateName);
    const checkDerivedPrivateName =
      options.checkDerivedPrivateNames === true && privateName.includes("_");
    if (
      privateName.length > 0 &&
      (value.includes(privateName) ||
        (checkDerivedPrivateName &&
          normalizedPrivateName.length > 0 &&
          normalizedValue.includes(normalizedPrivateName)))
    ) {
      return null;
    }
  }

  return value;
}

function authMethodSummaryForCatalog(
  id: ConnectorRegistryAuthMethodId,
  method: ConnectorAuthMethodConfig,
  privateNames: ReadonlySet<string>,
): PublicConnectorCatalogAuthMethodSummary {
  return {
    id,
    label: method.label,
    description: publicTextOrNull(method.helpText, privateNames),
    grantKind: method.grant.kind,
  };
}

function manualFieldsForCatalog(
  type: ConnectorType,
  id: ConnectorRegistryAuthMethodId,
  method: ConnectorAuthMethodConfig,
  privateNames: ReadonlySet<string>,
): PublicConnectorCatalogManualField[] {
  if (method.grant.kind !== "manual") {
    return [];
  }
  return (
    getPublicManualGrantFieldDescriptors(type, id)?.map((descriptor) => {
      const field = descriptor.config;
      return {
        id: descriptor.publicId,
        label: field.label,
        required: field.required,
        placeholder: publicTextOrNull(field.placeholder, privateNames, {
          checkDerivedPrivateNames: true,
        }),
        inputType: field.storage === "variable" ? "text" : "password",
      };
    }) ?? []
  );
}

function startOptionsForCatalog(
  type: ConnectorType,
  id: ConnectorRegistryAuthMethodId,
  method: ConnectorAuthMethodConfig,
): PublicConnectorCatalogStartOption[] {
  if (method.grant.kind !== "device-auth") {
    return [];
  }
  return (
    getPublicDeviceAuthStartOptionDescriptors(type, id)?.map((descriptor) => {
      const option = descriptor.config;
      return {
        id: descriptor.publicId,
        kind: option.kind,
        label: option.label,
        required: option.required,
        defaultValue: option.defaultValue ?? null,
        options: option.options.map((choice) => {
          return { value: choice.value, label: choice.label };
        }),
      };
    }) ?? []
  );
}

function authMethodDetailForCatalog(
  type: ConnectorType,
  id: ConnectorRegistryAuthMethodId,
  method: ConnectorAuthMethodConfig,
  privateNames: ReadonlySet<string>,
): PublicConnectorCatalogAuthMethodDetail {
  return {
    ...authMethodSummaryForCatalog(id, method, privateNames),
    manualFields: manualFieldsForCatalog(type, id, method, privateNames),
    startOptions: startOptionsForCatalog(type, id, method),
  };
}

function connectorCatalogItem(
  type: ConnectorType,
  authMethods: readonly ConnectorRegistryAuthMethodId[],
): PublicConnectorCatalogItem {
  const config = CONNECTOR_TYPES[type];
  const privateNames = new Set(getConnectorPrivateNames(type, authMethods));
  return {
    connectorRef: type,
    label: config.label,
    description: config.helpText,
    icon: getStaticPublicConnectorCatalogIcon(type),
    category: config.category,
    generation: [...getConnectorGenerationTypes(type)],
    tags: [...getConnectorTags(type)],
    authMethods: authMethods.flatMap((authMethod) => {
      const method = getConnectorAuthMethod(type, authMethod);
      return method
        ? [authMethodSummaryForCatalog(authMethod, method, privateNames)]
        : [];
    }),
    permissionSummary: permissionSummaryForCatalog(type),
  };
}

function connectorCatalogDetail(
  type: ConnectorType,
  authMethods: readonly ConnectorRegistryAuthMethodId[],
): PublicConnectorCatalogDetail {
  const item = connectorCatalogItem(type, authMethods);
  const privateNames = new Set(getConnectorPrivateNames(type, authMethods));
  return {
    ...item,
    authMethods: authMethods.flatMap((authMethod) => {
      const method = getConnectorAuthMethod(type, authMethod);
      return method
        ? [authMethodDetailForCatalog(type, authMethod, method, privateNames)]
        : [];
    }),
  };
}

function connectionForCatalogStatus(
  connector: ConnectorResponse | null,
): PublicConnectorCatalogConnection | null {
  if (!connector) {
    return null;
  }
  return {
    authMethod: connector.authMethod,
    externalUsername: connector.externalUsername,
    externalEmail: connector.externalEmail,
    reconnectReason: connector.reconnectReason,
  };
}

function singleAuthCodeAuthMethodId(
  type: ConnectorType,
  authMethods: readonly ConnectorRegistryAuthMethodId[],
): ConnectorRegistryAuthMethodId | null {
  const [authMethod] = authMethods;
  if (authMethods.length !== 1 || !authMethod) {
    return null;
  }
  return getConnectorAuthMethod(type, authMethod)?.grant.kind === "auth-code"
    ? authMethod
    : null;
}

function connectorAuthMethodSupportsRefresh(
  type: ConnectorType,
  authMethod: string,
): boolean {
  return (
    getConnectorAuthMethodAccessMetadata(type, authMethod)?.kind ===
    "refresh-token"
  );
}

function connectorCatalogStatusItem(args: {
  readonly type: ConnectorType;
  readonly authMethods: readonly ConnectorRegistryAuthMethodId[];
  readonly connector: ConnectorResponse | null;
}): PublicConnectorCatalogStatusItem {
  const detail = connectorCatalogDetail(args.type, args.authMethods);
  const scopeMismatch =
    args.connector !== null &&
    !hasRequiredConnectorAuthMethodScopes(
      args.type,
      args.connector.authMethod,
      args.connector.oauthScopes,
    );
  let connectionStatus: PublicConnectorCatalogConnectionStatus =
    "not-connected";
  if (args.connector !== null) {
    connectionStatus =
      args.connector.connectionStatus === "reconnect-required"
        ? "reconnect-required"
        : scopeMismatch
          ? "scope-mismatch"
          : "connected";
  }

  return {
    ...detail,
    connection: connectionForCatalogStatus(args.connector),
    connected: args.connector !== null,
    connectionStatus,
    scopeMismatch,
    authMethodSupportsRefresh:
      args.connector !== null &&
      connectorAuthMethodSupportsRefresh(args.type, args.connector.authMethod),
    tokenExpiresAt: args.connector?.tokenExpiresAt ?? null,
    singleAuthCodeAuthMethodId: singleAuthCodeAuthMethodId(
      args.type,
      args.authMethods,
    ),
    connectNotice: null,
  };
}

function searchStaticConnectorCatalog(
  args: StaticConnectorCatalogReadArgs & {
    readonly keyword: string | undefined;
  },
): Promise<ConnectorSearchItem[]> {
  const keyword = args.keyword?.toLowerCase();

  const connectors = CONNECTOR_TYPE_KEYS.flatMap((type) => {
    const config = CONNECTOR_TYPES[type];
    const authMethods = getAvailableConnectorAuthMethodIds(
      type,
      args.featureStates,
      {
        apiAuthMethodPolicy: args.apiAuthMethodPolicy ?? "include",
      },
    );

    if (authMethods.length === 0) {
      return [];
    }

    const item = {
      id: type,
      label: config.label,
      description: config.helpText,
      authMethods,
    };
    const tags = getConnectorTags(type);

    if (
      keyword &&
      !item.label.toLowerCase().includes(keyword) &&
      !item.description.toLowerCase().includes(keyword) &&
      !tags.some((tag) => {
        return tag.toLowerCase().includes(keyword);
      })
    ) {
      return [];
    }

    return [item];
  });

  return Promise.resolve(connectors);
}

function listStaticPublicConnectorCatalog(
  args: StaticConnectorCatalogReadArgs,
): Promise<PublicConnectorCatalogListResponse> {
  const connectors = CONNECTOR_TYPE_KEYS.flatMap((type) => {
    const authMethods = availableAuthMethodsForCatalog(type, args);
    if (authMethods.length === 0) {
      return [];
    }
    return [connectorCatalogItem(type, authMethods)];
  });

  return Promise.resolve({
    connectors,
    categoryMetadata: connectorDisplayCategoryMetadataForItems(connectors),
  });
}

function listStaticPublicConnectorCatalogStatus(
  args: StaticConnectorCatalogReadArgs & {
    readonly connectors: readonly ConnectorResponse[];
  },
): Promise<PublicConnectorCatalogStatusResponse> {
  const connectorsByType = new Map(
    args.connectors.map((connector) => {
      return [connector.type, connector];
    }),
  );
  const connectors = CONNECTOR_TYPE_KEYS.flatMap((type) => {
    const authMethods = availableAuthMethodsForCatalog(type, args);
    if (authMethods.length === 0) {
      return [];
    }
    return [
      connectorCatalogStatusItem({
        type,
        authMethods,
        connector: connectorsByType.get(type) ?? null,
      }),
    ];
  });

  return Promise.resolve({
    connectors,
    categoryMetadata: connectorDisplayCategoryMetadataForItems(connectors),
  });
}

export function getStaticPublicConnectorCatalogDetail(
  args: StaticConnectorCatalogReadArgs & {
    readonly connectorRef: string;
  },
): Promise<PublicConnectorCatalogDetail | null> {
  if (!isConnectorType(args.connectorRef)) {
    return Promise.resolve(null);
  }
  const authMethods = availableAuthMethodsForCatalog(args.connectorRef, args);
  if (authMethods.length === 0) {
    return Promise.resolve(null);
  }
  return Promise.resolve(
    connectorCatalogDetail(args.connectorRef, authMethods),
  );
}

/**
 * Read catalog membership before user-specific availability filtering.
 *
 * Action resolution uses this view to distinguish an unknown catalog identity
 * from a known connector or method that is unavailable to the current user.
 */
export function getStaticConnectorCatalogResolutionDetail(
  connectorRef: string,
): Promise<PublicConnectorCatalogDetail | null> {
  if (!isConnectorType(connectorRef)) {
    return Promise.resolve(null);
  }
  return Promise.resolve(
    connectorCatalogDetail(
      connectorRef,
      getConfiguredConnectorAuthMethodIds(connectorRef),
    ),
  );
}

async function getStaticPublicConnectorCatalogPermissionDetail(
  args: StaticConnectorCatalogReadArgs & {
    readonly connectorRef: string;
  },
): Promise<PublicConnectorCatalogPermissionDetail | null> {
  if (!isConnectorType(args.connectorRef)) {
    return null;
  }
  const authMethods = availableAuthMethodsForCatalog(args.connectorRef, args);
  if (authMethods.length === 0) {
    return null;
  }

  const metadata = await loadFirewallPermissionMetadata(args.connectorRef);
  if (!metadata) {
    return null;
  }

  return {
    connectorRef: args.connectorRef,
    label: metadata.label,
    icon: getStaticPublicConnectorCatalogIcon(args.connectorRef),
    permissionCount: metadata.permissionCount,
    permissions: metadata.permissions.map((permission) => {
      return {
        name: permission.name,
        ...(permission.description
          ? { description: permission.description }
          : {}),
      };
    }),
    categories: metadata.categories
      ? {
          categories: { ...metadata.categories.categories },
          displayOrder: [...metadata.categories.displayOrder],
        }
      : null,
    defaultPolicy: {
      permissionDefault: metadata.defaultPolicy.permissionDefault,
      ...(metadata.defaultPolicy.permissionOverrides
        ? {
            permissionOverrides: Object.fromEntries(
              Object.entries(metadata.defaultPolicy.permissionOverrides).map(
                ([policy, permissions]) => {
                  return [policy, [...permissions]];
                },
              ),
            ),
          }
        : {}),
      unknownPolicy: metadata.defaultPolicy.unknownPolicy,
    },
  };
}

async function readSelectedCatalog<T>(args: {
  readonly staticRead: () => Promise<T>;
  readonly externalRead: () => Promise<ExternalConnectorCatalogRead<T>>;
}): Promise<T> {
  if (isExternalConnectorCatalogEnabled()) {
    return (await args.externalRead()).value;
  }
  return await args.staticRead();
}

export async function searchConnectorCatalog(
  args: ConnectorCatalogSearchArgs,
): Promise<ConnectorSearchItem[]> {
  return await readSelectedCatalog({
    staticRead: async () => {
      return await searchStaticConnectorCatalog(args);
    },
    externalRead: async () => {
      return await searchExternalConnectorCatalog({
        db: args.db,
        keyword: args.keyword,
        featureStates: args.featureStates,
      });
    },
  });
}

export async function listPublicConnectorCatalog(
  args: ConnectorCatalogReadArgs,
): Promise<PublicConnectorCatalogListResponse> {
  return await readSelectedCatalog({
    staticRead: async () => {
      return await listStaticPublicConnectorCatalog(args);
    },
    externalRead: async () => {
      return await listExternalPublicConnectorCatalog({
        db: args.db,
        featureStates: args.featureStates,
      });
    },
  });
}

export async function readPublicConnectorCatalogStatus(
  args: ConnectorCatalogReadArgs & {
    readonly connectors: readonly ConnectorResponse[];
    readonly referenceConnectorRefs: readonly string[];
  },
): Promise<ConnectorCatalogStatusRead> {
  return await readSelectedCatalog({
    staticRead: async () => {
      return {
        status: await listStaticPublicConnectorCatalogStatus(args),
        referenceMetadata: listStaticConnectorCatalogReferenceMetadata(
          args.referenceConnectorRefs,
        ),
      };
    },
    externalRead: async () => {
      return await listExternalPublicConnectorCatalogStatus({
        db: args.db,
        featureStates: args.featureStates,
        connectors: args.connectors,
        referenceConnectorRefs: args.referenceConnectorRefs,
      });
    },
  });
}

export async function listPublicConnectorCatalogStatus(
  args: ConnectorCatalogReadArgs & {
    readonly connectors: readonly ConnectorResponse[];
  },
): Promise<PublicConnectorCatalogStatusResponse> {
  const read = await readPublicConnectorCatalogStatus({
    ...args,
    referenceConnectorRefs: [],
  });
  return read.status;
}

export async function getPublicConnectorCatalogDetail(
  args: ConnectorCatalogConnectorReadArgs,
): Promise<PublicConnectorCatalogDetail | null> {
  return await readSelectedCatalog({
    staticRead: async () => {
      return await getStaticPublicConnectorCatalogDetail(args);
    },
    externalRead: async () => {
      return await getExternalPublicConnectorCatalogDetail({
        db: args.db,
        connectorRef: args.connectorRef,
        featureStates: args.featureStates,
      });
    },
  });
}

export async function getPublicConnectorCatalogPermissionDetail(
  args: ConnectorCatalogConnectorReadArgs,
): Promise<PublicConnectorCatalogPermissionDetail | null> {
  return await readSelectedCatalog({
    staticRead: async () => {
      return await getStaticPublicConnectorCatalogPermissionDetail(args);
    },
    externalRead: async () => {
      return await getExternalPublicConnectorCatalogPermissionDetail({
        db: args.db,
        connectorRef: args.connectorRef,
        featureStates: args.featureStates,
      });
    },
  });
}
