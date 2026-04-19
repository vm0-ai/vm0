/**
 * Connectors API Handlers
 *
 * Mock handlers for /api/zero/connectors endpoint (connectors via zero layer).
 */

import {
  CONNECTOR_TYPES,
  type ConnectorResponse,
  type ConnectorType,
  zeroConnectorsByTypeContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsMainContract,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

const ALL_CONNECTOR_TYPES = Object.keys(CONNECTOR_TYPES) as ConnectorType[];

let mockConnectors: ConnectorResponse[] = [];

export function setMockConnectors(connectors: ConnectorResponse[]): void {
  mockConnectors = connectors;
}

export function resetMockConnectors(): void {
  mockConnectors = [];
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
];
