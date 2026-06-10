import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface CustomConnectorFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly connector: CustomConnectorResponse;
}

function uniqueOrg(prefix: string) {
  const userId = `user_${prefix}_${randomUUID().slice(0, 8)}`;
  const orgId = `org_${prefix}_${randomUUID().slice(0, 8)}`;
  return { userId, orgId };
}

function validConnectorBody() {
  return {
    displayName: "Seeded",
    prefixes: ["https://api.example.com/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
  };
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

async function createConnector(
  track: (
    fixturePromise: Promise<CustomConnectorFixture>,
  ) => Promise<CustomConnectorFixture>,
  fixture = uniqueOrg("zcc-del"),
) {
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  const client = setupApp({ context })(zeroCustomConnectorsContract);
  const response = await accept(
    client.create({
      body: validConnectorBody(),
      headers: authHeaders(),
    }),
    [201],
  );
  return track(Promise.resolve({ ...fixture, connector: response.body }));
}

async function setSecret(connectorId: string) {
  const client = setupApp({ context })(zeroCustomConnectorSecretContract);
  await accept(
    client.set({
      params: { id: connectorId },
      body: { value: "sk_live_xyz" },
      headers: authHeaders(),
    }),
    [204],
  );
}

async function listConnectors() {
  const client = setupApp({ context })(zeroCustomConnectorsContract);
  const response = await accept(client.list({ headers: authHeaders() }), [200]);
  return response.body.connectors;
}

describe("DELETE /api/zero/custom-connectors/:id", () => {
  const track = createFixtureTracker<CustomConnectorFixture>(
    async (fixture) => {
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      const client = setupApp({ context })(zeroCustomConnectorByIdContract);
      await accept(
        client.delete({
          params: { id: fixture.connector.id },
          headers: authHeaders(),
        }),
        [204, 404],
      );
    },
  );

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const { userId } = uniqueOrg("zcc-del-no-org");
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.delete({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for non-admin members and leaves the connector visible", async () => {
    const fixture = await createConnector(track, uniqueOrg("zcc-del-member"));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.delete({
        params: { id: fixture.connector.id },
        headers: authHeaders(),
      }),
      [403],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can delete custom connectors",
        code: "FORBIDDEN",
      },
    });

    const connectors = await listConnectors();
    expect(connectors).toContainEqual(fixture.connector);
  });

  it("returns 404 for an unknown id", async () => {
    const { userId, orgId } = uniqueOrg("zcc-del-404");
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.delete({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("deletes connector as admin and removes it from the connector list", async () => {
    const fixture = await createConnector(track, uniqueOrg("zcc-del-cascade"));
    await setSecret(fixture.connector.id);

    const beforeDelete = await listConnectors();
    expect(beforeDelete).toContainEqual({
      ...fixture.connector,
      hasSecret: true,
    });

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await client.delete({
      params: { id: fixture.connector.id },
      headers: authHeaders(),
    });
    expect(response.status).toBe(204);

    const afterDelete = await listConnectors();
    expect(afterDelete).toStrictEqual([]);
  });

  it("returns 404 for a connector in another org and leaves it visible to the owner org", async () => {
    const fixture = await createConnector(track, uniqueOrg("zcc-del-orgA"));
    const orgB = uniqueOrg("zcc-del-orgB");
    mocks.clerk.session(orgB.userId, orgB.orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.delete({
        params: { id: fixture.connector.id },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const connectors = await listConnectors();
    expect(connectors).toContainEqual(fixture.connector);
  });
});
