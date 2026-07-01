import {
  CONNECTOR_TYPE_KEYS,
  type ConnectorAuthMethodId,
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
  type PublicConnectorCatalogConnection,
  type PublicConnectorCatalogConnectionStatus,
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
import { getFirewallPermissionSummary } from "@vm0/connectors/firewall-metadata";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { mockApi } from "../msw-contract.ts";

const FEATURE_SWITCH_CACHE_KEY = "vm0:feature-switch-cache:v1";

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
              manualFields: [],
              startOptions: [],
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
    return respond(200, { connectors: mockConnectorCatalogStatus() });
  }),

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
