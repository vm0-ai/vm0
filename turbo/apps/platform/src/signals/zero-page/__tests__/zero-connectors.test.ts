import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  setupPage,
  updateTestPathname$,
} from "../../../__tests__/page-helper.ts";
import { allConnectorTypes$ } from "../settings/connectors.ts";
import { zeroAddedConnectors$ } from "../zero-connectors.ts";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";

const context = testContext();

describe("connectors", () => {
  it("should show gmail connector without any feature switch", async () => {
    detachedSetupPage({
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
    const gmailConnector = connectorTypes.find((c) => {
      return c.type === "gmail";
    });

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
              id: "d0000001-0000-4000-a000-000000000001",
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

    detachedSetupPage({
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
    const firstConnectedIdx = connectorTypes.findIndex((c) => {
      return c.connected;
    });
    const firstUnconnectedIdx = connectorTypes.findIndex((c) => {
      return !c.connected;
    });

    // All connected connectors should appear before all unconnected ones
    expect(firstConnectedIdx).toBe(0);
    expect(firstUnconnectedIdx).toBeGreaterThan(0);
    // Verify no unconnected connector appears before a connected one
    const allConnectedBeforeUnconnected = connectorTypes.every((c, i) => {
      return c.connected || i >= firstUnconnectedIdx;
    });
    expect(allConnectedBeforeUnconnected).toBeTruthy();

    // GitHub should be connected and at position 0
    expect(connectorTypes[0].type).toBe("github" as ConnectorType);
    expect(connectorTypes[0].connected).toBeTruthy();
  });
});

describe("zero connectors — agent switch", () => {
  it("should return seeded connectors for new agent after switching", async () => {
    // Mock two agents with different user-connector permissions
    server.use(
      http.get("*/api/zero/agents/agent-a", () => {
        return HttpResponse.json({
          name: "agent-a",
          agentId: "uuid-a",
          ownerId: "test-owner-id",
          description: null,
          displayName: "Agent A",
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
        });
      }),
      http.get("*/api/zero/agents/agent-b", () => {
        return HttpResponse.json({
          name: "agent-b",
          agentId: "uuid-b",
          ownerId: "test-owner-id",
          description: null,
          displayName: "Agent B",
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
        });
      }),
      http.get("*/api/zero/agents/:id/user-connectors", ({ params }) => {
        if (params["id"] === "uuid-a" || params["id"] === "agent-a") {
          return HttpResponse.json({ enabledTypes: ["github"] });
        }
        return HttpResponse.json({ enabledTypes: ["slack"] });
      }),
    );

    await setupPage({
      context,
      path: "/agents/agent-a",
      withoutRender: true,
    });

    // Agent A should have github as seeded connector
    const initialConnectors = await context.store.get(zeroAddedConnectors$);
    expect(initialConnectors).toStrictEqual(["github"]);

    // Switch to agent B by updating the pathname
    context.store.set(updateTestPathname$, "/agents/agent-b");

    // Agent B's seeded connectors should show
    const agentBConnectors = await context.store.get(zeroAddedConnectors$);
    expect(agentBConnectors).toStrictEqual(["slack"]);
  });
});
