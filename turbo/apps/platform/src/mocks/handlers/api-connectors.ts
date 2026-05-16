import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import {
  zeroConnectorsByTypeContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroCliAuthStripeContract } from "@vm0/api-contracts/contracts/zero-connectors-cli-auth-stripe";
import { mockApi } from "../msw-contract.ts";

const ALL_CONNECTOR_TYPES = Object.keys(CONNECTOR_TYPES) as ConnectorType[];

let mockConnectors: ConnectorResponse[] = [];

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

export function setMockStripeCliAuthCompleteResponse(
  response: MockStripeCliAuthCompleteResponse,
): void {
  mockStripeCliAuthCompleteResponse = response;
}

export const apiConnectorsHandlers = [
  mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
    return respond(200, {
      connectors: mockConnectors,
      configuredTypes: ALL_CONNECTOR_TYPES,
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
