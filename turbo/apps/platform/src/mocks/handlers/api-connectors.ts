import {
  CONNECTOR_DISPLAY_CATEGORY_GROUPS,
  CONNECTOR_DISPLAY_CATEGORY_META,
  CONNECTOR_DISPLAY_CATEGORY_ORDER,
  CONNECTOR_TYPE_KEYS,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodId,
  type ConnectorDisplayCategory,
  type ConnectorDisplayCategoryGroup,
  type ConnectorType,
  CONNECTOR_TYPES,
} from "@vm0/connectors/connectors";
import type {
  ConnectorExternalCodeSessionStartResponse,
  ConnectorOauthDeviceAuthSessionPollResponse,
  ConnectorOauthDeviceAuthSessionStartResponse,
  ConnectorResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogAuthMethodDetail,
  type PublicConnectorCatalogCategoryMetadata,
  type PublicConnectorCatalogConnection,
  type PublicConnectorCatalogConnectionStatus,
  type PublicConnectorCatalogPermissionDetail,
  type PublicConnectorCatalogPermissionSummary,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  zeroConnectorExternalCodeSessionContract,
  zeroConnectorManualGrantContract,
  zeroConnectorOauthDeviceAuthSessionContract,
  zeroConnectorsByTypeContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { isGoogleOAuthConnector } from "@vm0/connectors/auth-providers/oauth/google-connectors";
import {
  getAvailableConnectorAuthMethodIds,
  getConnectorAuthMethod,
  getConnectorAuthMethodAccessMetadata,
  getConnectorGenerationTypes,
  getConnectorTags,
  hasRequiredConnectorAuthMethodScopes,
  type ConnectorFeatureStates,
} from "@vm0/connectors/connector-utils";
import {
  getFirewallPermissionSummary,
  loadFirewallPermissionMetadata,
} from "@vm0/connectors/firewall-metadata";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { mockApi } from "../msw-contract.ts";

const FEATURE_SWITCH_CACHE_KEY = "vm0:feature-switch-cache:v1";
const MOCK_CONNECTOR_TYPE_SET = new Set<string>(CONNECTOR_TYPE_KEYS);

let mockConnectors: ConnectorResponse[] = [];
type MockOauthDeviceAuthSessionStartResponse = Omit<
  Partial<ConnectorOauthDeviceAuthSessionStartResponse>,
  "verificationUriComplete"
> & {
  readonly verificationUriComplete?: string | undefined;
};

let mockOauthDeviceAuthSessionStartResponse:
  | MockOauthDeviceAuthSessionStartResponse
  | undefined;
let mockOauthDeviceAuthSessionPollResponses: ConnectorOauthDeviceAuthSessionPollResponse[] =
  [];

let mockExternalCodeSessionStartResponse:
  | Partial<ConnectorExternalCodeSessionStartResponse>
  | undefined;

function createMockOauthDeviceAuthConnector(
  type: ConnectorType,
): ConnectorResponse {
  const now = "2026-01-01T00:00:00Z";
  return {
    id: crypto.randomUUID(),
    type,
    authMethod: "oauth",
    externalId: `mock-${type}-external-id`,
    externalUsername: `mock-${type}`,
    externalEmail: null,
    oauthScopes: ["read"],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function defaultOauthDeviceAuthSessionStartResponse(
  type: ConnectorType,
): ConnectorOauthDeviceAuthSessionStartResponse {
  return {
    sessionId: "00000000-0000-4000-8000-000000000001",
    sessionToken: `mock-${type}-oauth-device-session-token`,
    type,
    status: "pending",
    userCode: "VM0-DEVICE",
    verificationUri: `https://oauth.test/${type}/device`,
    verificationUriComplete: `https://oauth.test/${type}/device?user_code=VM0-DEVICE`,
    expiresIn: 300,
    interval: 1,
  };
}

function createMockManualGrantConnector(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): ConnectorResponse {
  return {
    id: crypto.randomUUID(),
    type,
    authMethod,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createMockExternalCodeConnector(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): ConnectorResponse {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: crypto.randomUUID(),
    type,
    authMethod,
    externalId: `mock-${type}-account`,
    externalUsername: `arn:aws:iam::000000000000:user/mock-${type}`,
    externalEmail: null,
    oauthScopes: ["openid"],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: new Date(Date.parse(now) + 15 * 60 * 1000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
}

function defaultExternalCodeSessionStartResponse(
  type: ConnectorType,
): ConnectorExternalCodeSessionStartResponse {
  return {
    sessionId: "00000000-0000-4000-8000-000000000002",
    sessionToken: `mock-${type}-external-code-session-token`,
    type,
    status: "pending",
    authorizationUrl: `https://oauth.test/${type}/external-code`,
    expiresIn: 600,
  };
}

export function setMockConnectors(connectors: ConnectorResponse[]): void {
  mockConnectors = connectors;
}

export function resetMockConnectors(): void {
  mockConnectors = [];
  resetMockOauthDeviceAuth();
}

function upsertMockConnector(connector: ConnectorResponse): void {
  mockConnectors = [
    ...mockConnectors.filter((c) => {
      return c.type !== connector.type;
    }),
    connector,
  ];
}

function resetMockOauthDeviceAuth(): void {
  mockOauthDeviceAuthSessionStartResponse = undefined;
  mockOauthDeviceAuthSessionPollResponses = [];
  mockExternalCodeSessionStartResponse = undefined;
}

function mockFeatureStates(): ConnectorFeatureStates {
  const raw = globalThis.localStorage?.getItem(FEATURE_SWITCH_CACHE_KEY);
  return raw
    ? (JSON.parse(raw) as Record<string, boolean>)
    : getAllFeatureStates({});
}

function isMockConnectorType(type: string): type is ConnectorType {
  return MOCK_CONNECTOR_TYPE_SET.has(type);
}

function isConnectorDisplayCategory(
  category: string,
): category is ConnectorDisplayCategory {
  return Object.prototype.hasOwnProperty.call(
    CONNECTOR_DISPLAY_CATEGORY_META,
    category,
  );
}

function fallbackCategoryLabel(category: string): string {
  const label = category
    .split(/[-_\s]+/)
    .filter((part) => {
      return part.length > 0;
    })
    .map((part) => {
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
  return label || "Other";
}

function mockCategoryMetadata(
  items: readonly { readonly category: string }[],
): PublicConnectorCatalogCategoryMetadata {
  const visibleCategories = new Set(
    items.flatMap((item) => {
      return item.category ? [item.category] : [];
    }),
  );
  const orderedConnectorDisplayCategories =
    CONNECTOR_DISPLAY_CATEGORY_ORDER.filter((category) => {
      return visibleCategories.has(category);
    });
  const orderedCategoryIds = new Set<string>(orderedConnectorDisplayCategories);
  const orderedCategories = [
    ...orderedConnectorDisplayCategories,
    ...[...visibleCategories].filter((category) => {
      return !orderedCategoryIds.has(category);
    }),
  ];
  const visibleGroups = new Set<ConnectorDisplayCategoryGroup>();
  const categories = orderedCategories.map((category) => {
    if (!isConnectorDisplayCategory(category)) {
      const label = fallbackCategoryLabel(category);
      return {
        id: category,
        label,
        menuLabel: label,
        groupId: null,
      };
    }
    const metadata = CONNECTOR_DISPLAY_CATEGORY_META[category];
    if (metadata.group) {
      visibleGroups.add(metadata.group);
    }
    return {
      id: category,
      label: metadata.label,
      menuLabel: metadata.menuLabel,
      groupId: metadata.group ?? null,
    };
  });
  return {
    categories,
    groups: [...visibleGroups].map((group) => {
      const metadata = CONNECTOR_DISPLAY_CATEGORY_GROUPS[group];
      return {
        id: group,
        label: metadata.label,
        menuLabel: metadata.menuLabel,
      };
    }),
  };
}

function mockPermissionSummary(
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

async function mockPermissionDetail(
  connectorRef: string,
): Promise<PublicConnectorCatalogPermissionDetail | null> {
  if (!isMockConnectorType(connectorRef)) {
    return null;
  }

  const authMethods = getAvailableConnectorAuthMethodIds(
    connectorRef,
    mockFeatureStates(),
    { apiAuthMethodPolicy: "include" },
  );
  if (authMethods.length === 0) {
    return null;
  }

  const metadata = await loadFirewallPermissionMetadata(connectorRef);
  if (!metadata) {
    return null;
  }

  return {
    connectorRef,
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

function mockConnectionForCatalogStatus(
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

function mockSingleAuthCodeAuthMethodId(
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

function mockConnectorAuthMethodSupportsRefresh(
  type: ConnectorType,
  authMethod: string,
): boolean {
  return (
    getConnectorAuthMethodAccessMetadata(type, authMethod)?.kind ===
    "refresh-token"
  );
}

function mockManualFieldsForCatalog(
  method: ConnectorAuthMethodConfig,
): PublicConnectorCatalogAuthMethodDetail["manualFields"] {
  if (method.grant.kind !== "manual") {
    return [];
  }
  return Object.values(method.grant.fields).map((field) => {
    return {
      id: field.publicId,
      label: field.label,
      required: field.required,
      placeholder: field.placeholder ?? null,
      inputType: field.storage === "variable" ? "text" : "password",
    };
  });
}

function mockStartOptionsForCatalog(
  method: ConnectorAuthMethodConfig,
): PublicConnectorCatalogAuthMethodDetail["startOptions"] {
  if (method.grant.kind !== "device-auth") {
    return [];
  }
  return Object.values(method.grant.startOptions ?? {}).map((option) => {
    return {
      id: option.publicId,
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

function mockConnectorCatalogStatusItem(
  type: ConnectorType,
  authMethods: readonly ConnectorAuthMethodId[],
  connector: ConnectorResponse | null,
): PublicConnectorCatalogStatusItem {
  const config = CONNECTOR_TYPES[type];
  const scopeMismatch =
    connector !== null &&
    !hasRequiredConnectorAuthMethodScopes(
      type,
      connector.authMethod,
      connector.oauthScopes,
    );
  let connectionStatus: PublicConnectorCatalogConnectionStatus =
    "not-connected";
  if (connector !== null) {
    connectionStatus =
      connector.connectionStatus === "reconnect-required"
        ? "reconnect-required"
        : scopeMismatch
          ? "scope-mismatch"
          : "connected";
  }

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
        ? [
            {
              id: authMethod,
              label: method.label,
              description: method.helpText ?? null,
              grantKind: method.grant.kind,
              manualFields: mockManualFieldsForCatalog(method),
              startOptions: mockStartOptionsForCatalog(method),
            },
          ]
        : [];
    }),
    permissionSummary: mockPermissionSummary(type),
    connection: mockConnectionForCatalogStatus(connector),
    connected: connector !== null,
    connectionStatus,
    scopeMismatch,
    authMethodSupportsRefresh:
      connector !== null &&
      mockConnectorAuthMethodSupportsRefresh(type, connector.authMethod),
    tokenExpiresAt: connector?.tokenExpiresAt ?? null,
    singleAuthCodeAuthMethodId: mockSingleAuthCodeAuthMethodId(
      type,
      authMethods,
    ),
    connectNotice: isGoogleOAuthConnector(type)
      ? "google-security-warning"
      : null,
  };
}

function mockConnectorCatalogStatus(): PublicConnectorCatalogStatusItem[] {
  const connectorsByType = new Map(
    mockConnectors.map((connector) => {
      return [connector.type, connector];
    }),
  );
  const featureStates = mockFeatureStates();
  return CONNECTOR_TYPE_KEYS.flatMap((type) => {
    const authMethods = getAvailableConnectorAuthMethodIds(
      type,
      featureStates,
      { apiAuthMethodPolicy: "include" },
    );
    if (authMethods.length === 0) {
      return [];
    }
    return [
      mockConnectorCatalogStatusItem(
        type,
        authMethods,
        connectorsByType.get(type) ?? null,
      ),
    ];
  });
}

export const apiConnectorsHandlers = [
  mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
    return respond(200, {
      connectors: mockConnectors,
      configuredTypes: [...CONNECTOR_TYPE_KEYS],
      connectorProvidedBindings: [],
    });
  }),

  mockApi(zeroConnectorCatalogContract.status, ({ respond }) => {
    const connectors = mockConnectorCatalogStatus();
    return respond(200, {
      connectors,
      categoryMetadata: mockCategoryMetadata(connectors),
    });
  }),

  mockApi(
    zeroConnectorCatalogContract.permissions,
    async ({ params, respond }) => {
      const permissions = await mockPermissionDetail(params.connectorRef);
      if (!permissions) {
        return respond(404, {
          error: { message: "Connector not found", code: "NOT_FOUND" },
        });
      }
      return respond(200, { permissions });
    },
  ),

  mockApi(zeroConnectorsByTypeContract.delete, ({ params, respond }) => {
    const type = params.type as string;
    const existing = mockConnectors.find((c) => {
      return c.type === type;
    });

    if (!existing) {
      return respond(404, {
        error: { message: "Connector not found", code: "NOT_FOUND" },
      });
    }

    mockConnectors = mockConnectors.filter((c) => {
      return c.type !== type;
    });
    return respond(204);
  }),

  mockApi(
    zeroConnectorManualGrantContract.connect,
    ({ body, params, respond }) => {
      const connector = createMockManualGrantConnector(
        params.type,
        body.authMethod,
      );
      upsertMockConnector(connector);
      return respond(200, connector);
    },
  ),

  mockApi(zeroConnectorScopeDiffContract.getScopeDiff, ({ respond }) => {
    return respond(200, {
      addedScopes: [],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });
  }),

  mockApi(
    zeroConnectorOauthDeviceAuthSessionContract.create,
    ({ params, respond }) => {
      const response = {
        ...defaultOauthDeviceAuthSessionStartResponse(params.type),
        ...mockOauthDeviceAuthSessionStartResponse,
        type: mockOauthDeviceAuthSessionStartResponse?.type ?? params.type,
      };
      if (
        mockOauthDeviceAuthSessionStartResponse &&
        "verificationUriComplete" in mockOauthDeviceAuthSessionStartResponse &&
        mockOauthDeviceAuthSessionStartResponse.verificationUriComplete ===
          undefined
      ) {
        delete response.verificationUriComplete;
      }
      return respond(200, response);
    },
  ),

  mockApi(
    zeroConnectorOauthDeviceAuthSessionContract.poll,
    ({ params, respond }) => {
      const response =
        mockOauthDeviceAuthSessionPollResponses.shift() ??
        ({
          status: "complete",
          connector: createMockOauthDeviceAuthConnector(params.type),
        } satisfies ConnectorOauthDeviceAuthSessionPollResponse);

      if (response.status === "complete") {
        upsertMockConnector(response.connector);
      }
      return respond(200, response);
    },
  ),

  mockApi(
    zeroConnectorExternalCodeSessionContract.create,
    ({ params, respond }) => {
      return respond(200, {
        ...defaultExternalCodeSessionStartResponse(params.type),
        ...mockExternalCodeSessionStartResponse,
        type: mockExternalCodeSessionStartResponse?.type ?? params.type,
      });
    },
  ),

  mockApi(
    zeroConnectorExternalCodeSessionContract.complete,
    ({ body, params, respond }) => {
      if (!body.code) {
        return respond(400, {
          error: { message: "Missing authorization code", code: "BAD_REQUEST" },
        });
      }
      const connector = createMockExternalCodeConnector(params.type, "cli");
      upsertMockConnector(connector);
      return respond(200, { status: "complete", connector });
    },
  ),
];
