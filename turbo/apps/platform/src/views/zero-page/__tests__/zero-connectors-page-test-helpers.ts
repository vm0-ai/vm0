import type { ConnectorType } from "@vm0/connectors/connectors";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";

export function mockConnectors(
  connectors: {
    type: ConnectorType;
    authMethod?: "oauth" | "api-token";
    externalUsername?: string;
    needsReconnect?: boolean;
    oauthScopes?: string[];
  }[],
) {
  setMockConnectors(
    connectors.map((c) => {
      return {
        id: crypto.randomUUID(),
        type: c.type,
        authMethod: c.authMethod ?? "oauth",
        externalId: null,
        externalUsername: c.externalUsername ?? null,
        externalEmail: null,
        oauthScopes: c.oauthScopes ?? null,
        needsReconnect: c.needsReconnect ?? false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
    }),
  );
}
