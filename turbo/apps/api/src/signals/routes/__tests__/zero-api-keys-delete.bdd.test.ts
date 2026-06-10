import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { expect, it } from "vitest";
import {
  apiKeysByIdContract,
  apiKeysContract,
} from "@vm0/api-contracts/contracts/api-keys";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteApiKeys$,
  seedApiKeys$,
  type ApiKeysFixture,
} from "./helpers/zero-api-keys";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-api-keys-delete.test.ts`. The Given
// seeds an API key row directly because no public route lets a user
// create a key without going through the POST flow — recorded in
// `api.bdd.md` under "Open Helper Gaps". The Then step is verified
// through the public `apiKeysContract.list` endpoint instead of a
// direct DB row read.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function seedRow(name: string, suffix: string) {
  return {
    name,
    token: `vm0_pat_${suffix}_${randomUUID().slice(0, 8)}`,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    expiresAt: new Date("2026-04-01T00:00:00.000Z"),
  };
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function deleteClient() {
  return setupApp({ context })(apiKeysByIdContract);
}

function listClient() {
  return setupApp({ context })(apiKeysContract);
}

describe("BDD DELETE /api/zero/api-keys/:id — auth boundary", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      deleteClient().delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD DELETE /api/zero/api-keys/:id — ownership chain", () => {
  const track = createFixtureTracker<ApiKeysFixture>((fixture) => {
    return store.set(deleteApiKeys$, fixture, context.signal);
  });

  it("gwt-wt-wt: 404 unknown id → 204 deletes own key → 404 protects other user's key", async () => {
    // Given: a user exists with a seeded key; the LIST endpoint will
    // reflect it on the next call.
    const fixture = await track(
      store.set(seedApiKeys$, [seedRow("to delete", "del")], context.signal),
    );
    const ownTokenId = fixture.tokenIds[0];
    expect(ownTokenId).toBeDefined();

    // Pre-condition check via the LIST endpoint (the only public read).
    mocks.clerk.session(fixture.userId, `org_${randomUUID().slice(0, 8)}`);
    const list0 = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      list0.body.apiKeys.map((key) => {
        return key.id;
      }),
    ).toContain(ownTokenId);

    // When + Then: DELETE for an unknown id returns 404.
    const unknown = await accept(
      deleteClient().delete({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(unknown.body).toStrictEqual({
      error: { message: "API key not found", code: "NOT_FOUND" },
    });

    // When + Then: DELETE for the caller's own key returns 204 with an
    // empty body.
    const deleted = await accept(
      deleteClient().delete({
        params: { id: ownTokenId! },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(deleted.body).toBeUndefined();

    // Then: a follow-up LIST no longer includes the deleted key.
    const list1 = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      list1.body.apiKeys.map((key) => {
        return key.id;
      }),
    ).not.toContain(ownTokenId);

    // Given: a separate victim user with a key.
    const victim = await track(
      store.set(
        seedApiKeys$,
        [seedRow("victim's key", "victim")],
        context.signal,
      ),
    );
    const victimTokenId = victim.tokenIds[0];
    expect(victimTokenId).toBeDefined();

    // When: a different attacker user authenticates and tries to delete
    // the victim's key.
    const attackerUserId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(attackerUserId, `org_${randomUUID().slice(0, 8)}`);

    // Then: the route returns 404 (no existence leak) and the victim's
    // key is preserved.
    const blocked = await accept(
      deleteClient().delete({
        params: { id: victimTokenId! },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(blocked.body).toStrictEqual({
      error: { message: "API key not found", code: "NOT_FOUND" },
    });

    // Re-authenticate as the victim and confirm the key is still in
    // their LIST.
    mocks.clerk.session(victim.userId, `org_${randomUUID().slice(0, 8)}`);
    const victimList = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      victimList.body.apiKeys.map((key) => {
        return key.id;
      }),
    ).toContain(victimTokenId);
  });
});
