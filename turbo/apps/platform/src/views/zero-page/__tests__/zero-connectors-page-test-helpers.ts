import { http, HttpResponse } from "msw";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { server } from "../../../mocks/server.ts";

export function mockConnectors(
  connectors: {
    type: ConnectorType;
    externalUsername?: string;
    needsReconnect?: boolean;
    oauthScopes?: string[];
  }[],
) {
  server.use(
    http.get("*/api/zero/connectors", () => {
      return HttpResponse.json({
        connectors: connectors.map((c) => {
          return {
            id: crypto.randomUUID(),
            type: c.type,
            authMethod: "oauth",
            externalId: null,
            externalUsername: c.externalUsername ?? null,
            externalEmail: null,
            oauthScopes: c.oauthScopes ?? null,
            needsReconnect: c.needsReconnect ?? false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          };
        }),
        configuredTypes: Object.keys(CONNECTOR_TYPES),
        connectorProvidedSecretNames: [],
      });
    }),
  );
}
