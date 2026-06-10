import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

describe("DELETE /api/zero/api-keys/:id", () => {
  const track = createFixtureTracker<ApiKeysFixture>((fixture) => {
    return store.set(deleteApiKeys$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(apiKeysByIdContract);
    const response = await accept(
      client.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("deletes the caller's own key", async () => {
    const fixture = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(fixture.userId, `org_${randomUUID().slice(0, 8)}`);

    const apiKeysClient = setupApp({ context })(apiKeysContract);
    const created = await apiKeysClient.create({
      headers: authHeaders(),
      body: { name: "to delete", expiresInDays: 30 },
    });
    expect(created.status).toBe(201);
    if (created.status !== 201) {
      throw new Error(`Expected 201, received ${created.status}`);
    }

    const deleteClient = setupApp({ context })(apiKeysByIdContract);
    const response = await accept(
      deleteClient.delete({
        params: { id: created.body.id },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(response.body).toBeUndefined();

    const listed = await accept(
      apiKeysClient.list({ headers: authHeaders() }),
      [200],
    );
    expect(
      listed.body.apiKeys.some((apiKey) => {
        return apiKey.id === created.body.id;
      }),
    ).toBeFalsy();
  });

  it("returns 404 for an unknown id", async () => {
    const fixture = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(fixture.userId, `org_${randomUUID().slice(0, 8)}`);

    const client = setupApp({ context })(apiKeysByIdContract);
    const response = await accept(
      client.delete({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "API key not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 when another user owns the key (no leak)", async () => {
    const victim = await track(store.set(seedApiKeys$, [], context.signal));
    const apiKeysClient = setupApp({ context })(apiKeysContract);
    mocks.clerk.session(victim.userId, `org_${randomUUID().slice(0, 8)}`);
    const created = await apiKeysClient.create({
      headers: authHeaders(),
      body: { name: "victim's key", expiresInDays: 30 },
    });
    expect(created.status).toBe(201);
    if (created.status !== 201) {
      throw new Error(`Expected 201, received ${created.status}`);
    }

    // Authenticate as a different user; victim is unrelated.
    const attackerUserId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(attackerUserId, `org_${randomUUID().slice(0, 8)}`);

    const client = setupApp({ context })(apiKeysByIdContract);
    const response = await accept(
      client.delete({
        params: { id: created.body.id },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "API key not found", code: "NOT_FOUND" },
    });

    mocks.clerk.session(victim.userId, `org_${randomUUID().slice(0, 8)}`);
    const listed = await accept(
      apiKeysClient.list({ headers: authHeaders() }),
      [200],
    );
    expect(listed.body.apiKeys).toContainEqual({
      id: created.body.id,
      name: "victim's key",
      tokenPrefix: created.body.tokenPrefix,
      createdAt: created.body.createdAt,
      expiresAt: created.body.expiresAt,
      lastUsedAt: null,
    });
  });
});
