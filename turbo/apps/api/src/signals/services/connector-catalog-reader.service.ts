import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogAuthMethodSummary,
  PublicConnectorCatalogDetail,
  PublicConnectorCatalogItem,
  PublicConnectorCatalogManualField,
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogPermissionSummary,
  PublicConnectorCatalogStartOption,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { ConnectorSearchItem } from "@vm0/api-contracts/contracts/zero-connectors";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodId,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  getAvailableConnectorAuthMethodIds,
  getConnectorAuthMethod,
  getConnectorGenerationTypes,
  getConnectorTags,
  type ApiAuthMethodPolicy,
  type ConnectorFeatureStates,
} from "@vm0/connectors/connector-utils";
import {
  getFirewallPermissionSummary,
  loadFirewallPermissionMetadata,
} from "@vm0/connectors/firewall-metadata";

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

function authMethodSummaryForCatalog(
  id: ConnectorAuthMethodId,
  method: ConnectorAuthMethodConfig,
): PublicConnectorCatalogAuthMethodSummary {
  return {
    id,
    label: method.label,
    description: method.helpText ?? null,
    grantKind: method.grant.kind,
  };
}

function manualFieldsForCatalog(
  method: ConnectorAuthMethodConfig,
): PublicConnectorCatalogManualField[] {
  if (method.grant.kind !== "manual") {
    return [];
  }
  return Object.values(method.grant.fields).map((field, index) => {
    return {
      id: `field-${index + 1}`,
      label: field.label,
      required: field.required,
      placeholder: field.placeholder ?? null,
      inputType: field.storage === "variable" ? "text" : "password",
    };
  });
}

function startOptionsForCatalog(
  method: ConnectorAuthMethodConfig,
): PublicConnectorCatalogStartOption[] {
  if (method.grant.kind !== "device-auth") {
    return [];
  }
  return Object.values(method.grant.startOptions ?? {}).map((option, index) => {
    return {
      id: `option-${index + 1}`,
      kind: option.kind,
      label: option.label,
      required: option.required,
      defaultValue: option.defaultValue ?? null,
      options: option.options.map((choice) => {
        return { value: choice.value, label: choice.label };
      }),
    };
  });
}

function authMethodDetailForCatalog(
  id: ConnectorAuthMethodId,
  method: ConnectorAuthMethodConfig,
): PublicConnectorCatalogAuthMethodDetail {
  return {
    ...authMethodSummaryForCatalog(id, method),
    manualFields: manualFieldsForCatalog(method),
    startOptions: startOptionsForCatalog(method),
  };
}

function connectorCatalogItem(
  type: ConnectorType,
  authMethods: readonly ConnectorAuthMethodId[],
): PublicConnectorCatalogItem {
  const config = CONNECTOR_TYPES[type];
  return {
    connectorRef: type,
    label: config.label,
    description: config.helpText,
    category: config.category,
    generation: [...getConnectorGenerationTypes(type)],
    tags: [...getConnectorTags(type)],
    authMethods: authMethods.flatMap((authMethod) => {
      const method = getConnectorAuthMethod(type, authMethod);
      return method ? [authMethodSummaryForCatalog(authMethod, method)] : [];
    }),
    permissionSummary: permissionSummaryForCatalog(type),
  };
}

function connectorCatalogDetail(
  type: ConnectorType,
  authMethods: readonly ConnectorAuthMethodId[],
): PublicConnectorCatalogDetail {
  const item = connectorCatalogItem(type, authMethods);
  return {
    ...item,
    authMethods: authMethods.flatMap((authMethod) => {
      const method = getConnectorAuthMethod(type, authMethod);
      return method ? [authMethodDetailForCatalog(authMethod, method)] : [];
    }),
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
): Promise<PublicConnectorCatalogItem[]> {
  const connectors = CONNECTOR_TYPE_KEYS.flatMap((type) => {
    const authMethods = availableAuthMethodsForCatalog(type, args);
    if (authMethods.length === 0) {
      return [];
    }
    return [connectorCatalogItem(type, authMethods)];
  });

  return Promise.resolve(connectors);
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
