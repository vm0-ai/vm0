import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import {
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteCustomConnectorOrg$,
  type CustomConnectorFixture,
} from "./helpers/zero-custom-connectors";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function validConnectorBody() {
  return {
    displayName: "Example",
    prefixes: ["https://api.example.com/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
  };
}

describe("PUT /api/zero/custom-connectors/:id/secret", () => {
  const track = createFixtureTracker<CustomConnectorFixture>((fixture) => {
    return store.set(deleteCustomConnectorOrg$, fixture, context.signal);
  });

  it("returns 401 when the user has no active organization", async () => {
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, null);

    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    const response = await accept(
      client.set({
        params: { id: randomUUID() },
        body: { value: "x" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("stores per-user secret and exposes the secret flag through list", async () => {
    const fixture = {
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
    };
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const listClient = setupApp({ context })(zeroCustomConnectorsContract);
    const created = await accept(
      listClient.create({
        body: validConnectorBody(),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    await track(Promise.resolve({ ...fixture, connectorId: created.body.id }));

    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    await accept(
      client.set({
        params: { id: created.body.id },
        body: { value: "sk_live_xyz" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    const listResponse = await accept(
      listClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(listResponse.body.connectors).toContainEqual({
      ...created.body,
      hasSecret: true,
    });
  });

  it("returns 404 for an unknown connector id", async () => {
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:admin",
    );

    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    const response = await accept(
      client.set({
        params: { id: randomUUID() },
        body: { value: "x" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("allows an org member (non-admin) to set their own secret", async () => {
    const fixture = {
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
    };
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const listClient = setupApp({ context })(zeroCustomConnectorsContract);
    const created = await accept(
      listClient.create({
        body: validConnectorBody(),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    await track(Promise.resolve({ ...fixture, connectorId: created.body.id }));
    // The connector creator was fixture.userId (the seeding admin). A different
    // user in the same org should be able to set their own secret.
    const memberUserId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(memberUserId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    await accept(
      client.set({
        params: { id: created.body.id },
        body: { value: "member-token" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    const memberListResponse = await accept(
      listClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(memberListResponse.body.connectors).toContainEqual({
      ...created.body,
      hasSecret: true,
    });

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const adminListResponse = await accept(
      listClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(adminListResponse.body.connectors).toContainEqual(created.body);
  });
});
