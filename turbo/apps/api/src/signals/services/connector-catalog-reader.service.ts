import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogAuthMethodSummary,
  PublicConnectorCatalogConnection,
  PublicConnectorCatalogConnectionStatus,
  PublicConnectorCatalogDetail,
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
import { isGoogleOAuthConnector } from "@vm0/connectors/auth-providers/oauth/google-connectors";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  connectorDisplayCategoryMetadataForItems,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodId,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  getAvailableConnectorAuthMethodIds,
  getConnectorAuthMethodAccessMetadata,
  getConnectorAuthMethod,
  getConnectorPrivateNames,
  getConnectorGenerationTypes,
  getConnectorTags,
  hasRequiredConnectorAuthMethodScopes,
  type ApiAuthMethodPolicy,
  type ConnectorFeatureStates,
} from "@vm0/connectors/connector-utils";
import {
  getFirewallPermissionSummary,
  loadFirewallPermissionMetadata,
} from "@vm0/connectors/firewall-metadata";
import {
  getPublicDeviceAuthStartOptionDescriptors,
  getPublicManualGrantFieldDescriptors,
} from "./connector-catalog-form-fields.service";

interface ConnectorCatalogSearchArgs {
  readonly keyword: string | undefined;
  readonly featureStates: ConnectorFeatureStates;
  readonly apiAuthMethodPolicy?: ApiAuthMethodPolicy;
}

interface ConnectorCatalogReadArgs {
  readonly featureStates: ConnectorFeatureStates;
  readonly apiAuthMethodPolicy?: ApiAuthMethodPolicy;
}

interface ConnectorCatalogConnectorReadArgs extends ConnectorCatalogReadArgs {
  readonly connectorRef: string;
}

function isConnectorType(connectorRef: string): connectorRef is ConnectorType {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_TYPES, connectorRef);
}

function availableAuthMethodsForCatalog(
  type: ConnectorType,
  args: ConnectorCatalogReadArgs,
): ConnectorAuthMethodId[] {
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
  id: ConnectorAuthMethodId,
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
  id: ConnectorAuthMethodId,
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
  id: ConnectorAuthMethodId,
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
  id: ConnectorAuthMethodId,
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
  authMethods: readonly ConnectorAuthMethodId[],
): PublicConnectorCatalogItem {
  const config = CONNECTOR_TYPES[type];
  const privateNames = new Set(getConnectorPrivateNames(type, authMethods));
  return {
    connectorRef: type,
    label: config.label,
    description: config.helpText,
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
  authMethods: readonly ConnectorAuthMethodId[],
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
  authMethods: readonly ConnectorAuthMethodId[],
): ConnectorAuthMethodId | null {
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
  readonly authMethods: readonly ConnectorAuthMethodId[];
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
    connectNotice: isGoogleOAuthConnector(args.type)
      ? "google-security-warning"
      : null,
  };
}

export function searchConnectorCatalog(
  args: ConnectorCatalogSearchArgs,
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

export function listPublicConnectorCatalog(
  args: ConnectorCatalogReadArgs,
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

export function listPublicConnectorCatalogStatus(
  args: ConnectorCatalogReadArgs & {
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

export function getPublicConnectorCatalogDetail(
  args: ConnectorCatalogConnectorReadArgs,
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

export async function getPublicConnectorCatalogPermissionDetail(
  args: ConnectorCatalogConnectorReadArgs,
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
