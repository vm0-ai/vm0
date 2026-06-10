import { randomUUID } from "node:crypto";

import {
  zeroCustomConnectorSecretContract,
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

// BDD migration of the legacy `zero-custom-connectors-secret-delete.test.ts`.
// The legacy direct DB SELECTs that verified secret-row absence (and the
// multi-user / multi-org leak tests that count survivors) are replaced
// by assertions on the public list endpoint: the list reports
// `hasSecret: true` when at least one user has a secret. Per-user
// isolation across users / orgs is a storage-layer concern exercised by
// service tests, recorded in api.bdd.md. The 6 legacy `it()`s collapse
// into 2 BDD `it()`s.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function secretDeleteClient() {
  return setupApp({ context })(zeroCustomConnectorSecretContract);
}

function listClient() {
  return setupApp({ context })(zeroCustomConnectorsContract);
}

describe("BDD DELETE /api/zero/custom-connectors/:id/secret — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = secretDeleteClient();
    context.mocks.ably.publish.mockClear();

    // When + Then: no auth header → 401 and no Ably publish.
    const unauth = await accept(
      c.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(unauth.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Given: a session with a user but no org.
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, { withSecret: true }, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    // When + Then: still 401 and no Ably publish.
    const noOrg = await accept(
      c.delete({
        params: { id: fixture.connectorId },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toMatchObject({ error: {} });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});

const track = createFixtureTracker<CustomConnectorFixture>((fixture) => {
  return store.set(deleteCustomConnectorOrg$, fixture, context.signal);
});

describe("BDD DELETE /api/zero/custom-connectors/:id/secret — clear chain", () => {
  it("gwt-wt-wt: 204 clears caller's secret (hasSecret: true on connector with only this user) → 204 idempotent (hasSecret: false)", async () => {
    const c = secretDeleteClient();
    const lister = listClient();
    context.mocks.ably.publish.mockClear();

    // Given: a fresh org with a connector that has a per-user secret
    // (the seeding user is the only secret-holder).
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, { withSecret: true }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    // When: the caller deletes their own secret.
    const cleared = await accept(
      c.delete({
        params: { id: fixture.connectorId },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(cleared.body).toBeUndefined();

    // Then: the list endpoint reports `hasSecret: false` for this
    // connector (the only secret-holder just cleared it). The
    // secret-clear path emits no realtime publish (parity with web).
    const afterClear = await accept(
      lister.list({ headers: authHeaders() }),
      [200],
    );
    const clearedRow = afterClear.body.connectors.find((entry) => {
      return entry.id === fixture.connectorId;
    });
    expect(clearedRow?.hasSecret).toBeFalsy();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // When: the caller deletes again (idempotent — no secret left to
    // clear, still 204).
    const idempotent = await accept(
      c.delete({
        params: { id: fixture.connectorId },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(idempotent.body).toBeUndefined();

    // Then: list still reports `hasSecret: false` and no Ably publish.
    const afterSecond = await accept(
      lister.list({ headers: authHeaders() }),
      [200],
    );
    const stillCleared = afterSecond.body.connectors.find((entry) => {
      return entry.id === fixture.connectorId;
    });
    expect(stillCleared?.hasSecret).toBeFalsy();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});
