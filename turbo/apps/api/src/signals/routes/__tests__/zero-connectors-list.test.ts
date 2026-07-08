import { randomUUID } from "node:crypto";

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
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

function seedAuthenticatedFixture(): AuthenticatedFixture {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function connectGitlab(fixture: AuthenticatedFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context })(zeroConnectorManualGrantContract).connect({
      params: { type: "gitlab" },
      body: {
        authMethod: "api-token",
        values: {
          GITLAB_TOKEN: "gl-test-token",
          GITLAB_HOST: "gitlab.example.com",
        },
      },
      headers: authHeaders(),
    }),
    [200],
  );
}

async function deleteGitlab(fixture: AuthenticatedFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context })(zeroConnectorsByTypeContract).delete({
      params: { type: "gitlab" },
      headers: authHeaders(),
    }),
    [204, 404],
  );
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

describe("GET /api/zero/connectors", () => {
  const seededFixtures: AuthenticatedFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteGitlab(fixture);
        await deleteFeatureSwitches(fixture);
      }
    }
  });

  it("returns an empty connectors list", async () => {
    const fixture = seedAuthenticatedFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroConnectorsMainContract);
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.connectors).toStrictEqual([]);
    expect(Array.isArray(response.body.configuredTypes)).toBeTruthy();
    expect(Array.isArray(response.body.connectorProvidedBindings)).toBeTruthy();
  });

  it("filters configured connector types by feature availability", async () => {
    const fixture = seedAuthenticatedFixture();
    seededFixtures.push(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroConnectorsMainContract);
    const initial = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    expect(initial.body.configuredTypes).not.toContain(
      "nintendo-eshop-catalog",
    );

    await updateFeatureSwitches(fixture, {
      [FeatureSwitchKey.NintendoEshopCatalogConnector]: true,
    });

    const enabled = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    expect(enabled.body.configuredTypes).toContain("nintendo-eshop-catalog");
  });

  it("returns connectors created through the connector API", async () => {
    const fixture = seedAuthenticatedFixture();
    seededFixtures.push(fixture);
    await connectGitlab(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroConnectorsMainContract);
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.connectors).toContainEqual(
      expect.objectContaining({
        type: "gitlab",
        authMethod: "api-token",
        connectionStatus: "connected",
      }),
    );
    expect(response.body.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorType: "gitlab",
        namespace: "secrets",
        name: "GITLAB_TOKEN",
      }),
    );
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroConnectorsMainContract);
    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroConnectorsMainContract);
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
