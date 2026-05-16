import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import {
  zeroConnectorApiTokenContract,
  zeroConnectorsByTypeContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { mockApi } from "../msw-contract.ts";

const ALL_CONNECTOR_TYPES = Object.keys(CONNECTOR_TYPES) as ConnectorType[];

let mockConnectors: ConnectorResponse[] = [];

export function setMockConnectors(connectors: ConnectorResponse[]): void {
  mockConnectors = connectors;
}

export function resetMockConnectors(): void {
  mockConnectors = [];
}

export function upsertMockConnector(connector: ConnectorResponse): void {
  mockConnectors = [
    ...mockConnectors.filter((c) => {
      return c.type !== connector.type;
    }),
    connector,
  ];
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

  mockApi(zeroConnectorApiTokenContract.connect, ({ params, respond }) => {
    const now = "1970-01-01T00:00:00.000Z";
    const connector: ConnectorResponse = {
      id: null,
      type: params.type,
      authMethod: "api-token",
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: null,
      needsReconnect: false,
      createdAt: now,
      updatedAt: now,
    };
    upsertMockConnector(connector);
    return respond(200, connector);
  }),

  mockApi(zeroConnectorScopeDiffContract.getScopeDiff, ({ respond }) => {
    return respond(200, {
      addedScopes: [],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });
  }),
];
