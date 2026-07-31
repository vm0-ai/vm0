import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import type {
  ConnectorExternalCodeSessionStartResponse,
  ConnectorOauthDeviceAuthSessionPollResponse,
  ConnectorOauthDeviceAuthSessionStartResponse,
  ConnectorResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogAuthMethodDetail,
  type PublicConnectorCatalogConnection,
  type PublicConnectorCatalogConnectionStatus,
  type PublicConnectorCatalogPermissionDetail,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  zeroConnectorExternalCodeSessionContract,
  zeroConnectorManualGrantContract,
  zeroConnectorNoAuthGrantContract,
  zeroConnectorOauthDeviceAuthSessionContract,
  zeroConnectorsBySlugContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { FEATURE_SWITCH_CACHE_KEY } from "../../signals/external/feature-switch.ts";
import { mockApi } from "../msw-contract.ts";
import {
  testConnectorCatalogCategoryMetadata,
  testConnectorCatalogDefinitions,
  testConnectorPermissionDetails,
  testConnectorSlugs,
  type TestConnectorCatalogDefinition,
} from "./connector-catalog-fixtures.ts";

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
  connectorSlug: ConnectorSlug,
): ConnectorResponse {
  const now = "2026-01-01T00:00:00Z";
  return {
    id: crypto.randomUUID(),
    slug: connectorSlug,
    authMethod: "oauth",
    externalId: `mock-${connectorSlug}-external-id`,
    externalUsername: `mock-${connectorSlug}`,
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
  connectorSlug: ConnectorSlug,
): ConnectorOauthDeviceAuthSessionStartResponse {
  return {
    sessionId: "00000000-0000-4000-8000-000000000001",
    sessionToken: `mock-${connectorSlug}-oauth-device-session-token`,
    connectorSlug,
    status: "pending",
    userCode: "VM0-DEVICE",
    verificationUri: `https://oauth.test/${connectorSlug}/device`,
    verificationUriComplete: `https://oauth.test/${connectorSlug}/device?user_code=VM0-DEVICE`,
    expiresIn: 300,
    interval: 1,
  };
}

function createMockLocalGrantConnector(
  connectorSlug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
): ConnectorResponse {
  return {
    id: crypto.randomUUID(),
    slug: connectorSlug,
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
  connectorSlug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
): ConnectorResponse {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: crypto.randomUUID(),
    slug: connectorSlug,
    authMethod,
    externalId: `mock-${connectorSlug}-account`,
    externalUsername: `arn:aws:iam::000000000000:user/mock-${connectorSlug}`,
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
  connectorSlug: ConnectorSlug,
): ConnectorExternalCodeSessionStartResponse {
  return {
    sessionId: "00000000-0000-4000-8000-000000000002",
    sessionToken: `mock-${connectorSlug}-external-code-session-token`,
    connectorSlug,
    status: "pending",
    authorizationUrl: `https://oauth.test/${connectorSlug}/external-code`,
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
      return c.slug !== connector.slug;
    }),
    connector,
  ];
}

function resetMockOauthDeviceAuth(): void {
  mockOauthDeviceAuthSessionStartResponse = undefined;
  mockOauthDeviceAuthSessionPollResponses = [];
  mockExternalCodeSessionStartResponse = undefined;
}

function mockFeatureStates(): Readonly<Record<string, boolean>> {
  const raw = globalThis.localStorage?.getItem(FEATURE_SWITCH_CACHE_KEY);
  return raw
    ? (JSON.parse(raw) as Record<string, boolean>)
    : getAllFeatureStates({});
}

function mockPermissionDetail(
  connectorSlug: string,
): PublicConnectorCatalogPermissionDetail | null {
  return testConnectorPermissionDetails.get(connectorSlug) ?? null;
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
  authMethods: readonly PublicConnectorCatalogAuthMethodDetail[],
): ConnectorAuthMethodId | null {
  const [authMethod] = authMethods;
  if (authMethods.length !== 1 || !authMethod) {
    return null;
  }
  return authMethod.grantKind === "auth-code" ? authMethod.id : null;
}

function mockConnectorAuthMethodSupportsRefresh(
  definition: TestConnectorCatalogDefinition,
  authMethod: ConnectorAuthMethodId,
): boolean {
  return Boolean(
    definition.authMethods.find((method) => {
      return method.detail.id === authMethod;
    })?.supportsRefresh,
  );
}

function mockConnectorHasRequiredScopes(
  definition: TestConnectorCatalogDefinition,
  connector: ConnectorResponse,
): boolean {
  const method = definition.authMethods.find((candidate) => {
    return candidate.detail.id === connector.authMethod;
  });
  if (!method || method.requiredScopes.length === 0) {
    return true;
  }
  const storedScopes = connector.oauthScopes;
  if (!storedScopes) {
    return false;
  }
  const storedScopeSet = new Set(storedScopes);
  return method.requiredScopes.every((scope) => {
    return storedScopeSet.has(scope);
  });
}

function mockConnectorCatalogStatusItem(
  definition: TestConnectorCatalogDefinition,
  authMethods: readonly PublicConnectorCatalogAuthMethodDetail[],
  connector: ConnectorResponse | null,
): PublicConnectorCatalogStatusItem {
  const scopeMismatch =
    connector !== null &&
    !mockConnectorHasRequiredScopes(definition, connector);
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
    slug: definition.connectorSlug,
    label: definition.label,
    description: definition.description,
    icon: definition.icon,
    category: definition.category,
    generation: [...definition.generation],
    tags: [...definition.tags],
    authMethods: [...authMethods],
    permissionSummary: definition.permissionSummary,
    connection: mockConnectionForCatalogStatus(connector),
    connected: connector !== null,
    connectionStatus,
    scopeMismatch,
    authMethodSupportsRefresh:
      connector !== null &&
      mockConnectorAuthMethodSupportsRefresh(definition, connector.authMethod),
    tokenExpiresAt: connector?.tokenExpiresAt ?? null,
    singleAuthCodeAuthMethodId: mockSingleAuthCodeAuthMethodId(authMethods),
    connectNotice: definition.connectNotice,
  };
}

function mockConnectorCatalogStatus(): PublicConnectorCatalogStatusItem[] {
  const connectorsBySlug = new Map(
    mockConnectors.map((connector) => {
      return [connector.slug, connector];
    }),
  );
  const featureStates = mockFeatureStates();
  return testConnectorCatalogDefinitions.flatMap((definition) => {
    const authMethods = definition.authMethods.flatMap((method) => {
      return method.featureSwitch === undefined ||
        featureStates[method.featureSwitch] === true
        ? [method.detail]
        : [];
    });
    if (authMethods.length === 0) {
      return [];
    }
    return [
      mockConnectorCatalogStatusItem(
        definition,
        authMethods,
        connectorsBySlug.get(definition.connectorSlug) ?? null,
      ),
    ];
  });
}

export const apiConnectorsHandlers = [
  mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
    return respond(200, {
      connectors: mockConnectors,
      configuredConnectorSlugs: [...testConnectorSlugs],
      connectorProvidedBindings: [],
    });
  }),

  mockApi(zeroConnectorCatalogContract.status, ({ respond }) => {
    const connectors = mockConnectorCatalogStatus();
    return respond(200, {
      connectors,
      categoryMetadata: testConnectorCatalogCategoryMetadata,
    });
  }),

  mockApi(zeroCustomConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [] });
  }),

  mockApi(zeroConnectorCatalogContract.diagnostics, ({ respond }) => {
    return respond(200, {
      state: "stale",
      active: {
        catalogVersion: "2026-07-25.1",
        catalogDigest: `sha256:${"a".repeat(64)}`,
        activatedAt: "2026-07-25T01:00:00.000Z",
      },
      lastAttempt: {
        at: "2026-07-25T02:00:00.000Z",
        outcome: "rejected",
        failureCode: "invalid-artifact",
        reusedCachedRejection: true,
      },
      lastSuccessAt: "2026-07-25T02:00:00.000Z",
      rejectedCandidate: {
        catalogVersion: "2026-07-25.2",
        catalogDigest: `sha256:${"c".repeat(64)}`,
        failureCode: "invalid-artifact",
        backendVersion: "1.319.0",
      },
      filtering: {
        capabilityDigest: `sha256:${"b".repeat(64)}`,
        evaluatedAt: "2026-07-25T01:00:00.000Z",
        stale: false,
        filteredAuthMethods: [
          {
            connectorRef: "github",
            authMethodId: "oauth",
            reasons: ["missing-revoke-provider"],
          },
        ],
      },
      credentialStorage: {
        missingConnectorVersions: 1,
        unownedConnectorSecrets: 2,
        unownedConnectorVariables: 3,
        unresolvedBridgeCredentials: 5,
      },
    });
  }),

  mockApi(zeroConnectorCatalogContract.permissions, ({ params, respond }) => {
    const permissions = mockPermissionDetail(params.connectorSlug);
    if (!permissions) {
      return respond(404, {
        error: { message: "Connector not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, { permissions });
  }),

  mockApi(zeroConnectorsBySlugContract.delete, ({ params, respond }) => {
    const connectorSlug = params.connectorSlug;
    const existing = mockConnectors.find((c) => {
      return c.slug === connectorSlug;
    });

    if (!existing) {
      return respond(404, {
        error: { message: "Connector not found", code: "NOT_FOUND" },
      });
    }

    mockConnectors = mockConnectors.filter((c) => {
      return c.slug !== connectorSlug;
    });
    return respond(204);
  }),

  mockApi(
    zeroConnectorManualGrantContract.connect,
    ({ body, params, respond }) => {
      const connector = createMockLocalGrantConnector(
        params.connectorSlug,
        body.authMethod,
      );
      upsertMockConnector(connector);
      return respond(200, connector);
    },
  ),

  mockApi(
    zeroConnectorNoAuthGrantContract.connect,
    ({ body, params, respond }) => {
      const connector = createMockLocalGrantConnector(
        params.connectorSlug,
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
        ...defaultOauthDeviceAuthSessionStartResponse(params.connectorSlug),
        ...mockOauthDeviceAuthSessionStartResponse,
        connectorSlug:
          mockOauthDeviceAuthSessionStartResponse?.connectorSlug ??
          params.connectorSlug,
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
          connector: createMockOauthDeviceAuthConnector(params.connectorSlug),
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
        ...defaultExternalCodeSessionStartResponse(params.connectorSlug),
        ...mockExternalCodeSessionStartResponse,
        connectorSlug:
          mockExternalCodeSessionStartResponse?.connectorSlug ??
          params.connectorSlug,
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
      const connector = createMockExternalCodeConnector(
        params.connectorSlug,
        "cli",
      );
      upsertMockConnector(connector);
      return respond(200, { status: "complete", connector });
    },
  ),
];
