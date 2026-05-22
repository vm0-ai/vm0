import {
  CONNECTOR_TYPE_KEYS,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import type {
  ConnectorOauthDeviceAuthSessionPollResponse,
  ConnectorOauthDeviceAuthSessionStartResponse,
  ConnectorResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import {
  zeroConnectorOauthDeviceAuthSessionContract,
  zeroConnectorsByTypeContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroCliAuthStripeContract } from "@vm0/api-contracts/contracts/zero-connectors-cli-auth-stripe";
import { mockApi } from "../msw-contract.ts";

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

type MockStripeCliAuthStartResponse = {
  sessionToken: string;
  type: "stripe";
  status: "pending";
  mode: "test" | "live";
  browserUrl: string;
  verificationCode: string;
  expiresIn: number;
  interval: number;
};

type MockStripeCliAuthCompleteResponse =
  | {
      status: "pending";
      errorMessage: string | null;
    }
  | {
      status: "complete";
      connector: ConnectorResponse;
    };

function createMockStripeConnector(): ConnectorResponse {
  const now = "2026-01-01T00:00:00Z";
  return {
    id: crypto.randomUUID(),
    type: "stripe",
    authMethod: "api-token",
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    needsReconnect: false,
    createdAt: now,
    updatedAt: now,
  };
}

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
    needsReconnect: false,
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

function defaultStripeCliAuthStartResponse(
  mode: "test" | "live",
): MockStripeCliAuthStartResponse {
  return {
    sessionToken: "mock-stripe-cli-auth-session",
    type: "stripe",
    status: "pending",
    mode,
    browserUrl: "https://dashboard.stripe.com/stripecli/confirm_auth",
    verificationCode: "stripe-code-123",
    expiresIn: 300,
    interval: 5,
  };
}

let mockStripeCliAuthStartResponse:
  | Partial<MockStripeCliAuthStartResponse>
  | undefined;
let mockStripeCliAuthCompleteResponse:
  | MockStripeCliAuthCompleteResponse
  | undefined;

export function setMockConnectors(connectors: ConnectorResponse[]): void {
  mockConnectors = connectors;
}

export function resetMockConnectors(): void {
  mockConnectors = [];
  resetMockStripeCliAuth();
  resetMockOauthDeviceAuth();
}

export function upsertMockConnector(connector: ConnectorResponse): void {
  mockConnectors = [
    ...mockConnectors.filter((c) => {
      return c.type !== connector.type;
    }),
    connector,
  ];
}

function resetMockStripeCliAuth(): void {
  mockStripeCliAuthStartResponse = undefined;
  mockStripeCliAuthCompleteResponse = undefined;
}

function resetMockOauthDeviceAuth(): void {
  mockOauthDeviceAuthSessionStartResponse = undefined;
  mockOauthDeviceAuthSessionPollResponses = [];
}

export function setMockStripeCliAuthCompleteResponse(
  response: MockStripeCliAuthCompleteResponse,
): void {
  mockStripeCliAuthCompleteResponse = response;
}

export function setMockOauthDeviceAuthSessionStartResponse(
  response: MockOauthDeviceAuthSessionStartResponse,
): void {
  mockOauthDeviceAuthSessionStartResponse = response;
}

export function setMockOauthDeviceAuthSessionPollResponses(
  responses: ConnectorOauthDeviceAuthSessionPollResponse[],
): void {
  mockOauthDeviceAuthSessionPollResponses = responses;
}

export const apiConnectorsHandlers = [
  mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
    return respond(200, {
      connectors: mockConnectors,
      configuredTypes: [...CONNECTOR_TYPE_KEYS],
      connectorProvidedSecretNames: [],
    });
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

  mockApi(zeroCliAuthStripeContract.start, ({ body, respond }) => {
    return respond(200, {
      ...defaultStripeCliAuthStartResponse(body.mode),
      ...mockStripeCliAuthStartResponse,
      mode: mockStripeCliAuthStartResponse?.mode ?? body.mode,
    });
  }),

  mockApi(zeroCliAuthStripeContract.complete, ({ respond }) => {
    const response =
      mockStripeCliAuthCompleteResponse ??
      ({
        status: "complete",
        connector: createMockStripeConnector(),
      } satisfies MockStripeCliAuthCompleteResponse);

    if (response.status === "complete") {
      upsertMockConnector(response.connector);
    }
    return respond(200, response);
  }),
];
