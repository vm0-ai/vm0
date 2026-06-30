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

function addValueRefName(valueRef: string, privateNames: Set<string>): void {
  const match = /^\$(?:secrets|vars)\.(.+)$/.exec(valueRef);
  if (match?.[1]) {
    privateNames.add(match[1]);
  }
}

function addStoragePrivateNames(
  method: ConnectorAuthMethodConfig,
  privateNames: Set<string>,
): void {
  for (const secret of method.storage.secrets) {
    privateNames.add(secret);
  }
  for (const variable of method.storage.variables) {
    privateNames.add(variable);
  }
}

function addGrantPrivateNames(
  method: ConnectorAuthMethodConfig,
  privateNames: Set<string>,
): void {
  if (method.grant.kind === "manual") {
    for (const fieldName of Object.keys(method.grant.fields)) {
      privateNames.add(fieldName);
    }
  }

  if ("outputs" in method.grant) {
    for (const valueRef of Object.values(method.grant.outputs)) {
      addValueRefName(valueRef, privateNames);
    }
  }
}

function addAccessPrivateNames(
  method: ConnectorAuthMethodConfig,
  privateNames: Set<string>,
): void {
  if (method.access.kind === "none") {
    return;
  }

  for (const [envName, binding] of Object.entries(method.access.envBindings)) {
    privateNames.add(envName);
    addValueRefName(
      typeof binding === "string" ? binding : binding.valueRef,
      privateNames,
    );
  }
  for (const platformSecret of method.access.platformSecrets ?? []) {
    privateNames.add(platformSecret);
  }
}

function addRefreshPrivateNames(
  method: ConnectorAuthMethodConfig,
  privateNames: Set<string>,
): void {
  if (method.access.kind !== "refresh-token") {
    return;
  }

  for (const valueRef of Object.values(method.access.inputs)) {
    addValueRefName(valueRef, privateNames);
  }
  for (const valueRef of Object.values(method.access.outputs)) {
    addValueRefName(valueRef, privateNames);
  }
  for (const refreshableSecret of method.access.refreshableSecrets) {
    privateNames.add(refreshableSecret);
  }
}

function addRevokePrivateNames(
  method: ConnectorAuthMethodConfig,
  privateNames: Set<string>,
): void {
  if (method.revoke.kind !== "token-revoke") {
    return;
  }

  for (const valueRef of Object.values(method.revoke.inputs)) {
    addValueRefName(valueRef, privateNames);
  }
}

function addClientPrivateNames(
  method: ConnectorAuthMethodConfig,
  privateNames: Set<string>,
): void {
  if (!("client" in method) || !method.client) {
    return;
  }

  if ("clientIdEnv" in method.client) {
    privateNames.add(method.client.clientIdEnv);
  }
  if ("clientSecretEnv" in method.client) {
    privateNames.add(method.client.clientSecretEnv);
  }
}

function addPrivateNamesForAuthMethod(
  method: ConnectorAuthMethodConfig,
  privateNames: Set<string>,
): void {
  addStoragePrivateNames(method, privateNames);
  addGrantPrivateNames(method, privateNames);
  addAccessPrivateNames(method, privateNames);
  addRefreshPrivateNames(method, privateNames);
  addRevokePrivateNames(method, privateNames);
  addClientPrivateNames(method, privateNames);
}

function privateNamesForConnector(
  type: ConnectorType,
  authMethods: readonly ConnectorAuthMethodId[],
): ReadonlySet<string> {
  const privateNames = new Set<string>();
  for (const authMethod of authMethods) {
    const method = getConnectorAuthMethod(type, authMethod);
    if (method) {
      addPrivateNamesForAuthMethod(method, privateNames);
    }
  }
  return privateNames;
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
  method: ConnectorAuthMethodConfig,
  privateNames: ReadonlySet<string>,
): PublicConnectorCatalogManualField[] {
  if (method.grant.kind !== "manual") {
    return [];
  }
  return Object.values(method.grant.fields).map((field, index) => {
    return {
      id: `field-${index + 1}`,
      label: field.label,
      required: field.required,
      placeholder: publicTextOrNull(field.placeholder, privateNames, {
        checkDerivedPrivateNames: true,
      }),
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
  privateNames: ReadonlySet<string>,
): PublicConnectorCatalogAuthMethodDetail {
  return {
    ...authMethodSummaryForCatalog(id, method, privateNames),
    manualFields: manualFieldsForCatalog(method, privateNames),
    startOptions: startOptionsForCatalog(method),
  };
}

function connectorCatalogItem(
  type: ConnectorType,
  authMethods: readonly ConnectorAuthMethodId[],
): PublicConnectorCatalogItem {
  const config = CONNECTOR_TYPES[type];
  const privateNames = privateNamesForConnector(type, authMethods);
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
  const privateNames = privateNamesForConnector(type, authMethods);
  return {
    ...item,
    authMethods: authMethods.flatMap((authMethod) => {
      const method = getConnectorAuthMethod(type, authMethod);
      return method
        ? [authMethodDetailForCatalog(authMethod, method, privateNames)]
        : [];
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
