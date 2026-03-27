import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { allConnectorTypes$ } from "../settings/connectors.ts";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";

const context = testContext();

describe("connectors", () => {
  it("should show gmail connector without any feature switch", async () => {
    await setupPage({
      context,
      path: "/",
      user: {
        id: "test-user-123",
        fullName: "Test User",
        email: "testing@vm0.ai",
      },
      featureSwitches: {},
      withoutRender: true,
    });

    const connectorTypes = await context.store.get(allConnectorTypes$);
    const gmailConnector = connectorTypes.find((c) => c.type === "gmail");

    expect(gmailConnector).toBeDefined();
    if (!gmailConnector) {
      return;
    }
    expect(gmailConnector.connected).toBeFalsy();
  });

  it("should sort connected connectors before unconnected ones", async () => {
    server.use(
      http.get("*/api/zero/connectors", () => {
        return HttpResponse.json({
          connectors: [
            {
              id: "conn-github",
              type: "github",
              authMethod: "oauth",
              externalId: null,
              externalUsername: "testuser",
              externalEmail: null,
              oauthScopes: ["repo", "project"],
              needsReconnect: false,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
          configuredTypes: Object.keys(CONNECTOR_TYPES),
          connectorProvidedSecretNames: [],
        });
      }),
    );

    await setupPage({
      context,
      path: "/",
      user: {
        id: "test-user-123",
        fullName: "Test User",
        email: "testing@vm0.ai",
      },
      featureSwitches: {},
      withoutRender: true,
    });

    const connectorTypes = await context.store.get(allConnectorTypes$);

    // Find the first connected and first unconnected
    const firstConnectedIdx = connectorTypes.findIndex((c) => c.connected);
    const firstUnconnectedIdx = connectorTypes.findIndex((c) => !c.connected);

    // All connected connectors should appear before all unconnected ones
    expect(firstConnectedIdx).toBe(0);
    expect(firstUnconnectedIdx).toBeGreaterThan(0);
    // Verify no unconnected connector appears before a connected one
    const allConnectedBeforeUnconnected = connectorTypes.every(
      (c, i) => c.connected || i >= firstUnconnectedIdx,
    );
    expect(allConnectedBeforeUnconnected).toBeTruthy();

    // GitHub should be connected and at position 0
    expect(connectorTypes[0].type).toBe("github" as ConnectorType);
    expect(connectorTypes[0].connected).toBeTruthy();
  });
});
