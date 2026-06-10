import { randomUUID } from "node:crypto";

import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorsContract,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteCustomConnectorOrg$,
  seedCustomConnectorOrg$,
  type CustomConnectorFixture,
} from "./helpers/zero-custom-connectors";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-custom-connectors-delete.test.ts`. The
// legacy direct DB SELECTs that verified row presence/absence (e.g.
// "the connector is still there" and "secret cascade removed child
// rows") are replaced by assertions on the public list endpoint:
//  - cross-org safety is verified by re-authenticating as the org-A
//    owner and confirming the connector still appears in their list
//  - delete cascade is verified by the connector disappearing from
//    the list (secrets live behind the connector, so a missing
//    connector also covers the cascade for the public surface).
// The 6 legacy `it()`s collapse into 2 BDD `it()`s.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function deleteClient() {
  return setupApp({ context })(zeroCustomConnectorByIdContract);
}

function listClient() {
  return setupApp({ context })(zeroCustomConnectorsContract);
}

describe("BDD DELETE /api/zero/custom-connectors/:id — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = deleteClient();

    // When + Then: no auth header → 401.
    const unauth = await accept(
      c.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with a user but no org.
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    // When + Then: still 401.
    const noOrg = await accept(
      c.delete({
        params: { id: fixture.connectorId },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

const track = createFixtureTracker<CustomConnectorFixture>((fixture) => {
  return store.set(deleteCustomConnectorOrg$, fixture, context.signal);
});

describe("BDD DELETE /api/zero/custom-connectors/:id — delete chain", () => {
  it("gwt-wt-wt: 403 non-admin → 404 unknown → 404 cross-org (verified by re-auth) → 204 own (verified by list)", async () => {
    const c = deleteClient();
    const lister = listClient();

    // Given: a fresh org with one custom connector (the seeding user is
    // the connector creator and an admin).
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );

    // When + Then: a non-admin member gets 403.
    mocks.clerk.session(
      `user_${randomUUID().slice(0, 8)}`,
      fixture.orgId,
      "org:member",
    );
    const member = await accept(
      c.delete({
        params: { id: fixture.connectorId },
        headers: authHeaders(),
      }),
      [403],
    );
    expect(member.body).toMatchObject({
      error: { code: "FORBIDDEN" },
    });

    // When + Then: 404 for an unknown id (admin session).
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const unknown = await accept(
      c.delete({ params: { id: randomUUID() }, headers: authHeaders() }),
      [404],
    );
    expect(unknown.body).toMatchObject({ error: { code: "NOT_FOUND" } });

    // Given: another org owns a connector; the caller is an admin in a
    // different org.
    const otherOrgFixture = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    // When + Then: cross-org delete is 404 (no existence leak) and the
    // other-org connector is still listed to its rightful owner after
    // re-authentication.
    const crossOrg = await accept(
      c.delete({
        params: { id: otherOrgFixture.connectorId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossOrg.body).toMatchObject({ error: { code: "NOT_FOUND" } });

    mocks.clerk.session(
      otherOrgFixture.userId,
      otherOrgFixture.orgId,
      "org:admin",
    );
    const otherOrgList = await accept(
      lister.list({ headers: authHeaders() }),
      [200],
    );
    const otherOrgRow = otherOrgList.body.connectors.find((entry) => {
      return entry.id === otherOrgFixture.connectorId;
    });
    expect(otherOrgRow?.id).toBe(otherOrgFixture.connectorId);

    // Given: the original caller's connector (auth restored).
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    // When: the admin deletes their own connector.
    const deleted = await accept(
      c.delete({
        params: { id: fixture.connectorId },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(deleted.body).toBeUndefined();

    // Then: the list endpoint no longer reports the connector (the
    // public surface treats a missing connector as a missing secret
    // cascade as well).
    const afterList = await accept(
      lister.list({ headers: authHeaders() }),
      [200],
    );
    const survivor = afterList.body.connectors.find((entry) => {
      return entry.id === fixture.connectorId;
    });
    expect(survivor).toBeUndefined();
  });
});
