import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";

import {
  zeroPersonalModelProvidersByTypeContract,
  zeroPersonalModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-personal-model-providers";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteUserModelProviders$,
  type UserModelProviderFixture,
} from "./helpers/zero-model-providers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function uniqueOrgUser(prefix: string): UserModelProviderFixture {
  return {
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
  };
}

describe("DELETE /api/zero/me/model-providers/:type", () => {
  const track = createFixtureTracker<UserModelProviderFixture>((fixture) => {
    return store.set(deleteUserModelProviders$, fixture, context.signal);
  });

  async function upsertPersonalProvider(
    fixture: UserModelProviderFixture,
  ): Promise<void> {
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token", secret: "sk-ant-test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
  }

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(
      zeroPersonalModelProvidersByTypeContract,
    );
    const response = await accept(
      client.delete({ params: { type: "anthropic-api-key" }, headers: {} }),
      [401],
    );
    expect(response.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context })(
      zeroPersonalModelProvidersByTypeContract,
    );
    const response = await accept(
      client.delete({
        params: { type: "anthropic-api-key" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("deletes the user's personal provider", async () => {
    const fixture = uniqueOrgUser("zmmp-delete");
    await track(Promise.resolve(fixture));
    await upsertPersonalProvider(fixture);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersByTypeContract,
    );
    const response = await client.delete({
      params: { type: "claude-code-oauth-token" },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(204);

    const deletedAgain = await accept(
      client.delete({
        params: { type: "claude-code-oauth-token" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(deletedAgain.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 with 'Resource not found' when deleting a nonexistent provider", async () => {
    const fixture = uniqueOrgUser("zmmp-missing");
    await track(Promise.resolve(fixture));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersByTypeContract,
    );
    const response = await accept(
      client.delete({
        params: { type: "claude-code-oauth-token" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
  });

  it("does not delete another user's provider in the same organization", async () => {
    const orgId = `org_zmmp_cross_${randomUUID().slice(0, 8)}`;
    const alice = {
      orgId,
      userId: `user_alice_${randomUUID().slice(0, 8)}`,
    };
    const bob = {
      orgId,
      userId: `user_bob_${randomUUID().slice(0, 8)}`,
    };
    await track(Promise.resolve(alice));
    await track(Promise.resolve(bob));
    await upsertPersonalProvider(alice);
    mocks.clerk.session(bob.userId, orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersByTypeContract,
    );
    const response = await accept(
      client.delete({
        params: { type: "claude-code-oauth-token" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });

    mocks.clerk.session(alice.userId, orgId);
    const aliceDelete = await client.delete({
      params: { type: "claude-code-oauth-token" },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(aliceDelete.status).toBe(204);
  });
});
