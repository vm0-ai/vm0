import { randomUUID } from "node:crypto";

import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import {
  zeroConnectorNoAuthGrantContract,
  zeroConnectorsByTypeContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface AuthenticatedFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function seedFixture(): AuthenticatedFixture {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function updateFeatureSwitches(
  fixture: AuthenticatedFixture,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context })(zeroFeatureSwitchesContract).update({
      headers: authHeaders(),
      body: { switches },
    }),
    [200],
  );
}

async function deleteFeatureSwitches(
  fixture: AuthenticatedFixture,
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context })(zeroFeatureSwitchesContract).delete({
      headers: authHeaders(),
    }),
    [200],
  );
}

async function deleteNintendoConnector(
  fixture: AuthenticatedFixture,
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context })(zeroConnectorsByTypeContract).delete({
      params: { type: "nintendo-eshop-catalog" },
      headers: authHeaders(),
    }),
    [204, 404],
  );
}

describe("POST /api/zero/connectors/:type/no-auth", () => {
  const fixtures: AuthenticatedFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await deleteNintendoConnector(fixture);
        await deleteFeatureSwitches(fixture);
      }
    }
  });

  function trackFixture(): AuthenticatedFixture {
    const fixture = seedFixture();
    fixtures.push(fixture);
    return fixture;
  }

  it("returns 401 when not authenticated", async () => {
    const response = await accept(
      setupApp({ context })(zeroConnectorNoAuthGrantContract).connect({
        params: { type: "nintendo-eshop-catalog" },
        body: { authMethod: "api" },
        headers: {},
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects auth methods that are not no-auth grants", async () => {
    trackFixture();

    const response = await accept(
      setupApp({ context })(zeroConnectorNoAuthGrantContract).connect({
        params: { type: "openai" },
        body: { authMethod: "api-token" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      "openai api-token auth method does not use a no-auth grant",
    );
  });

  it("rejects feature-gated no-auth connectors when unavailable", async () => {
    trackFixture();

    const response = await accept(
      setupApp({ context })(zeroConnectorNoAuthGrantContract).connect({
        params: { type: "nintendo-eshop-catalog" },
        body: { authMethod: "api" },
        headers: authHeaders(),
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("creates a zero-credential local connector row when enabled", async () => {
    const fixture = trackFixture();
    await updateFeatureSwitches(fixture, {
      [FeatureSwitchKey.NintendoEshopCatalogConnector]: true,
    });

    const response = await accept(
      setupApp({ context })(zeroConnectorNoAuthGrantContract).connect({
        params: { type: "nintendo-eshop-catalog" },
        body: { authMethod: "api" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "nintendo-eshop-catalog",
      authMethod: "api",
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: null,
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
    });

    const stored = await accept(
      setupApp({ context })(zeroConnectorsByTypeContract).get({
        params: { type: "nintendo-eshop-catalog" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(stored.body).toMatchObject({
      type: "nintendo-eshop-catalog",
      authMethod: "api",
      connectionStatus: "connected",
    });

    const status = await accept(
      setupApp({ context })(zeroConnectorCatalogContract).status({
        headers: authHeaders(),
      }),
      [200],
    );
    const nintendo = status.body.connectors.find((connector) => {
      return connector.connectorRef === "nintendo-eshop-catalog";
    });
    expect(nintendo).toMatchObject({
      connectorRef: "nintendo-eshop-catalog",
      connected: true,
      connectionStatus: "connected",
      authMethods: [
        {
          id: "api",
          label: "Public catalog",
          grantKind: "none",
          manualFields: [],
          startOptions: [],
        },
      ],
    });
  });
});
