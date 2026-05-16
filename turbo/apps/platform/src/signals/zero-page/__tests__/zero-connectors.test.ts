import { describe, it, expect } from "vitest";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { allConnectorTypes$ } from "../settings/connectors.ts";
import { zeroAuthorizedConnectors$ } from "../zero-connectors.ts";
import { authorizeConnector$ as directedAuthorizeConnector$ } from "../../connectors-page/directed-authorize-type.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { server } from "../../../mocks/server.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";

const context = testContext();
const mockApi = createMockApi(context);
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

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
    setMockConnectors([
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
    ]);

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

  it("refreshes chat composer authorization state after directed authorize", async () => {
    let enabledTypes: string[] = [];
    server.use(
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        return respond(200, { enabledTypes });
      }),
      mockApi(zeroUserConnectorsContract.update, ({ body, respond }) => {
        enabledTypes = body.enabledTypes;
        return respond(200, { enabledTypes });
      }),
    );

    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    await expect(
      context.store.get(zeroAuthorizedConnectors$),
    ).resolves.toStrictEqual([]);

    await context.store.set(
      directedAuthorizeConnector$,
      "github",
      DEFAULT_AGENT_ID,
      context.signal,
    );

    await expect(
      context.store.get(zeroAuthorizedConnectors$),
    ).resolves.toStrictEqual(["github"]);
  });
});

describe("connectors — auth method feature flags", () => {
  it("hides bentoml when BentomlConnector feature switch is disabled", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.BentomlConnector]: false },
      withoutRender: true,
    });

    const connectorTypes = await context.store.get(allConnectorTypes$);
    const bentoml = connectorTypes.find((c) => {
      return c.type === "bentoml";
    });

    expect(bentoml).toBeUndefined();
  });

  it("shows bentoml when BentomlConnector feature switch is enabled", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.BentomlConnector]: true },
      withoutRender: true,
    });

    const connectorTypes = await context.store.get(allConnectorTypes$);
    const bentoml = connectorTypes.find((c) => {
      return c.type === "bentoml";
    });

    expect(bentoml).toBeDefined();
    expect(bentoml?.availableAuthMethods).toContain("api-token");
  });

  it("hides zapier when ZapierConnector feature switch is disabled", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ZapierConnector]: false },
      withoutRender: true,
    });

    const connectorTypes = await context.store.get(allConnectorTypes$);
    const zapier = connectorTypes.find((c) => {
      return c.type === "zapier";
    });

    expect(zapier).toBeUndefined();
  });

  it("shows zapier when ZapierConnector feature switch is enabled", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ZapierConnector]: true },
      withoutRender: true,
    });

    const connectorTypes = await context.store.get(allConnectorTypes$);
    const zapier = connectorTypes.find((c) => {
      return c.type === "zapier";
    });

    expect(zapier).toBeDefined();
    expect(zapier?.availableAuthMethods).toContain("api-token");
  });

  it("shows mercury because its api-token method is ungated", async () => {
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const connectorTypes = await context.store.get(allConnectorTypes$);
    const mercury = connectorTypes.find((c) => {
      return c.type === "mercury";
    });

    // mercury has an ungated api-token auth method, so it is always visible.
    expect(mercury).toBeDefined();
    expect(mercury?.availableAuthMethods).toContain("api-token");
  });
});

describe("connectors — CLI auth availability", () => {
  async function stripeAuthMethods(
    featureSwitches: Partial<Record<FeatureSwitchKey, boolean>>,
  ) {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches,
      withoutRender: true,
    });

    const connectorTypes = await context.store.get(allConnectorTypes$);
    const stripe = connectorTypes.find((c) => {
      return c.type === "stripe";
    });
    expect(stripe).toBeDefined();
    return stripe?.availableAuthMethods ?? [];
  }

  it.each([
    ["no Stripe CLI auth switch", {}, false],
    [
      "Stripe CLI auth without StripeConnector",
      {
        [FeatureSwitchKey.CliAuthStripe]: true,
        [FeatureSwitchKey.StripeConnector]: false,
      },
      true,
    ],
  ] as const)(
    "sets Stripe CLI auth availability for %s",
    async (_name, featureSwitches, expectedCliAuth) => {
      const authMethods = await stripeAuthMethods(featureSwitches);

      expect(authMethods).toContain("api-token");
      expect(authMethods.includes("cli-auth")).toBe(expectedCliAuth);
    },
  );
});
