import type {
  ConnectorAuthMethodId,
  ConnectorType,
} from "@vm0/connectors/connectors";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";

export function mockConnectors(
  connectors: {
    type: ConnectorType;
    authMethod?: ConnectorAuthMethodId;
    externalUsername?: string;
    connectionStatus?: "connected" | "reconnect-required";
    oauthScopes?: string[];
    tokenExpiresAt?: string | null;
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
        connectionStatus: c.connectionStatus ?? "connected",
        tokenExpiresAt: c.tokenExpiresAt ?? null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
    }),
  );
}
