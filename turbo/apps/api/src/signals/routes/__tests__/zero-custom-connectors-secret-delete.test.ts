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
  readonly orgId: string;
  readonly userId: string;
  readonly connector: CustomConnectorResponse;
}

interface OrgSession {
  readonly orgId: string;
  readonly userId: string;
}

function validConnectorBody() {
  return {
    displayName: "Example",
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
  fixture: OrgSession = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  },
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

async function setSecret(connectorId: string, value = "sk_live_xyz") {
  const client = setupApp({ context })(zeroCustomConnectorSecretContract);
  await accept(
    client.set({
      params: { id: connectorId },
      body: { value },
      headers: authHeaders(),
    }),
    [204],
  );
}

async function deleteSecret(connectorId: string) {
  const client = setupApp({ context })(zeroCustomConnectorSecretContract);
  const response = await accept(
    client.delete({
      params: { id: connectorId },
      headers: authHeaders(),
    }),
    [204],
  );
  expect(response.body).toBeUndefined();
}

async function listConnectors() {
  const client = setupApp({ context })(zeroCustomConnectorsContract);
  const response = await accept(client.list({ headers: authHeaders() }), [200]);
  return response.body.connectors;
}

describe("DELETE /api/zero/custom-connectors/:id/secret", () => {
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
    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    const response = await accept(
      client.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 401 when the user has no active organization", async () => {
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, null);
    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    const response = await accept(
      client.delete({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: {} });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("clears the caller's secret on success", async () => {
    const fixture = await createConnector(track);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await setSecret(fixture.connector.id);

    const beforeDelete = await listConnectors();
    expect(beforeDelete).toContainEqual({
      ...fixture.connector,
      hasSecret: true,
    });

    await deleteSecret(fixture.connector.id);

    const afterDelete = await listConnectors();
    expect(afterDelete).toContainEqual(fixture.connector);

    // Parity with web: no realtime publish on secret-clear.
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("is idempotent — second delete still 204 and changes nothing", async () => {
    const fixture = await createConnector(track);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    for (let i = 0; i < 2; i++) {
      await deleteSecret(fixture.connector.id);
    }

    const connectors = await listConnectors();
    expect(connectors).toContainEqual(fixture.connector);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("does not leak across users sharing a connector", async () => {
    const fixture = await createConnector(track);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await setSecret(fixture.connector.id);

    const otherUserId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(otherUserId, fixture.orgId, "org:member");
    await setSecret(fixture.connector.id, "other-user-secret");

    mocks.clerk.session(fixture.userId, fixture.orgId);
    await deleteSecret(fixture.connector.id);

    const callerConnectors = await listConnectors();
    expect(callerConnectors).toContainEqual(fixture.connector);

    mocks.clerk.session(otherUserId, fixture.orgId, "org:member");
    const otherUserConnectors = await listConnectors();
    expect(otherUserConnectors).toContainEqual({
      ...fixture.connector,
      hasSecret: true,
    });
  });

  it("does not leak across orgs (same userId in two orgs)", async () => {
    const sharedUserId = `user_${randomUUID().slice(0, 8)}`;
    const orgAFixture = await createConnector(track, {
      orgId: `org_${randomUUID()}`,
      userId: sharedUserId,
    });
    await setSecret(orgAFixture.connector.id);

    const orgBFixture = await createConnector(track, {
      orgId: `org_${randomUUID()}`,
      userId: sharedUserId,
    });
    await setSecret(orgBFixture.connector.id);

    // Authenticate as sharedUser in orgA. DELETE orgA's connector secret.
    mocks.clerk.session(sharedUserId, orgAFixture.orgId);
    await deleteSecret(orgAFixture.connector.id);

    const orgAConnectors = await listConnectors();
    expect(orgAConnectors).toContainEqual(orgAFixture.connector);

    mocks.clerk.session(sharedUserId, orgBFixture.orgId);
    const orgBConnectors = await listConnectors();
    expect(orgBConnectors).toContainEqual({
      ...orgBFixture.connector,
      hasSecret: true,
    });
  });
});
