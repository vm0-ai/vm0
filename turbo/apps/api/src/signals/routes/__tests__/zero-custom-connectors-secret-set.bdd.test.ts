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

// BDD migration of the legacy `zero-custom-connectors-secret-set.test.ts`.
// The legacy direct DB SELECT that verified the encrypted value decrypted
// to the original `value` is replaced by verifying that the public list
// endpoint reports `hasSecret: true` after the set call. The encryption
// roundtrip itself is storage-layer behavior exercised by service tests.
// The 4 legacy `it()`s collapse into 2 BDD `it()`s.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function secretSetClient() {
  return setupApp({ context })(zeroCustomConnectorSecretContract);
}

function listClient() {
  return setupApp({ context })(zeroCustomConnectorsContract);
}

describe("BDD PUT /api/zero/custom-connectors/:id/secret — auth boundary", () => {
  it("returns 401 when the user has no active organization", async () => {
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, null);

    // When + Then: org-less session → 401.
    const response = await accept(
      secretSetClient().set({
        params: { id: randomUUID() },
        body: { value: "x" },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

const track = createFixtureTracker<CustomConnectorFixture>((fixture) => {
  return store.set(deleteCustomConnectorOrg$, fixture, context.signal);
});

describe("BDD PUT /api/zero/custom-connectors/:id/secret — set chain", () => {
  it("gwt-wt-wt: 404 unknown → 204 admin sets secret (hasSecret: true) → 204 member sets own secret (hasSecret: true)", async () => {
    const c = secretSetClient();

    // Given: a fresh org with a custom connector (no per-user secret).
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    // When + Then: setting a secret for an unknown connector id → 404.
    const unknown = await accept(
      c.set({
        params: { id: randomUUID() },
        body: { value: "x" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(unknown.body).toMatchObject({ error: { code: "NOT_FOUND" } });

    // When: the admin sets a secret on the fixture's connector.
    await accept(
      c.set({
        params: { id: fixture.connectorId },
        body: { value: "sk_live_xyz" },
        headers: authHeaders(),
      }),
      [204],
    );

    // Then: the public list endpoint reports `hasSecret: true` for the
    // connector (org-level indicator — at least one user has a secret).
    const afterAdmin = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );
    const adminRow = afterAdmin.body.connectors.find((entry) => {
      return entry.id === fixture.connectorId;
    });
    expect(adminRow?.hasSecret).toBeTruthy();

    // Given: a different user in the same org (a non-admin member).
    const memberUserId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(memberUserId, fixture.orgId, "org:member");

    // When: the member sets their own secret.
    await accept(
      c.set({
        params: { id: fixture.connectorId },
        body: { value: "member-token" },
        headers: authHeaders(),
      }),
      [204],
    );

    // Then: the list still reports `hasSecret: true` (member was able to
    // set their own per-user secret; the list indicator is per-connector
    // across the org).
    const afterMember = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );
    const memberRow = afterMember.body.connectors.find((entry) => {
      return entry.id === fixture.connectorId;
    });
    expect(memberRow?.hasSecret).toBeTruthy();
  });
});
