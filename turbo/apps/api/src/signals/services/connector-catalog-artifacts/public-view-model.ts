import type {
  PublicConnectorCatalogAuthMethodSummary,
  PublicConnectorCatalogDetail,
  PublicConnectorCatalogItem,
  PublicConnectorCatalogPermissionDetail,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";

import type {
  ConnectorCatalogPublicArtifact,
  ConnectorCatalogPublicArtifactConnector,
  ConnectorCatalogPublicArtifactPermission,
} from "./schemas";

function authMethodSummary(
  authMethod: ConnectorCatalogPublicArtifactConnector["authMethods"][number],
): PublicConnectorCatalogAuthMethodSummary {
  return {
    id: authMethod.id,
    label: authMethod.label,
    description: authMethod.description,
    grantKind: authMethod.grantKind,
  };
}

function connectorCatalogArtifactToPublicItem(
  connector: ConnectorCatalogPublicArtifactConnector,
): PublicConnectorCatalogItem {
  return {
    connectorRef: connector.connectorRef,
    label: connector.label,
    description: connector.description,
    category: connector.category,
    generation: [...connector.generation],
    tags: [...connector.tags],
    authMethods: connector.authMethods.map(authMethodSummary),
    permissionSummary: { ...connector.permissionSummary },
  };
}

function connectorCatalogArtifactToPublicDetail(
  connector: ConnectorCatalogPublicArtifactConnector,
): PublicConnectorCatalogDetail {
  return {
    ...connectorCatalogArtifactToPublicItem(connector),
    authMethods: connector.authMethods.map((authMethod) => {
      return {
        ...authMethodSummary(authMethod),
        manualFields: authMethod.manualFields.map((field) => {
          return { ...field };
        }),
        startOptions: authMethod.startOptions.map((option) => {
          return {
            ...option,
            options: option.options.map((choice) => {
              return { ...choice };
            }),
          };
        }),
      };
    }),
  };
}

function connectorCatalogArtifactToPublicPermissionDetail(
  permission: ConnectorCatalogPublicArtifactPermission,
): PublicConnectorCatalogPermissionDetail {
  return {
    connectorRef: permission.connectorRef,
    label: permission.label,
    permissionCount: permission.permissionCount,
    permissions: permission.permissions.map((item) => {
      return { ...item };
    }),
    categories: permission.categories
      ? {
          categories: { ...permission.categories.categories },
          displayOrder: [...permission.categories.displayOrder],
        }
      : null,
    defaultPolicy: {
      permissionDefault: permission.defaultPolicy.permissionDefault,
      ...(permission.defaultPolicy.permissionOverrides
        ? {
            permissionOverrides: Object.fromEntries(
              Object.entries(permission.defaultPolicy.permissionOverrides).map(
                ([policy, permissions]) => {
                  return [policy, [...permissions]];
                },
              ),
            ),
          }
        : {}),
      unknownPolicy: permission.defaultPolicy.unknownPolicy,
    },
  };
}

export function listPublicConnectorCatalogFromArtifact(
  artifact: ConnectorCatalogPublicArtifact,
): PublicConnectorCatalogItem[] {
  return artifact.connectors.map(connectorCatalogArtifactToPublicItem);
}

export function getPublicConnectorCatalogDetailFromArtifact(
  artifact: ConnectorCatalogPublicArtifact,
  connectorRef: string,
): PublicConnectorCatalogDetail | null {
  const connector = artifact.connectors.find((item) => {
    return item.connectorRef === connectorRef;
  });
  return connector ? connectorCatalogArtifactToPublicDetail(connector) : null;
}

export function getPublicConnectorCatalogPermissionDetailFromArtifact(
  artifact: ConnectorCatalogPublicArtifact,
  connectorRef: string,
): PublicConnectorCatalogPermissionDetail | null {
  const permission = artifact.permissions.find((item) => {
    return item.connectorRef === connectorRef;
  });
  return permission
    ? connectorCatalogArtifactToPublicPermissionDetail(permission)
    : null;
}
