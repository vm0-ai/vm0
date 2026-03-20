/**
 * Connectors API Handlers
 *
 * Mock handlers for /api/zero/connectors endpoint (connectors via zero layer).
 */

import { http, HttpResponse } from "msw";
import {
  CONNECTOR_TYPES,
  type ConnectorResponse,
  type ConnectorListResponse,
  type ConnectorType,
} from "@vm0/core";

const ALL_CONNECTOR_TYPES = Object.keys(CONNECTOR_TYPES) as ConnectorType[];

let mockConnectors: ConnectorResponse[] = [];

export function resetMockConnectors(): void {
  mockConnectors = [];
}

export const apiConnectorsHandlers = [
  // GET /api/zero/connectors - List all connectors (zero proxy)
  http.get("*/api/zero/connectors", () => {
    const response: ConnectorListResponse = {
      connectors: mockConnectors,
      configuredTypes: ALL_CONNECTOR_TYPES,
      connectorProvidedSecretNames: [],
    };
    return HttpResponse.json(response);
  }),

  // DELETE /api/zero/connectors/:type - Disconnect a connector (zero proxy)
  http.delete("*/api/zero/connectors/:type", ({ params }) => {
    const type = params.type as string;
    const existing = mockConnectors.find((c) => c.type === type);

    if (!existing) {
      return HttpResponse.json(
        { error: { message: "Connector not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }

    mockConnectors = mockConnectors.filter((c) => c.type !== type);
    return new HttpResponse(null, { status: 204 });
  }),
];
