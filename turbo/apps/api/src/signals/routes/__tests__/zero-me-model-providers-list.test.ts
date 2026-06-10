import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";

import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteOrgModelProviders$,
  deleteUserModelProviders$,
  seedOrgModelProvider$,
  seedUserModelProvider$,
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

describe("GET /api/zero/me/model-providers", () => {
  const trackUsers = createFixtureTracker<UserModelProviderFixture>(
    async (fixture) => {
      await store.set(deleteUserModelProviders$, fixture, context.signal);
    },
  );
  const trackOrg = createFixtureTracker<{ readonly orgId: string }>(
    (fixture) => {
      return store.set(deleteOrgModelProviders$, fixture, context.signal);
    },
  );

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(client.list({ headers: {} }), [401]);
    expect(response.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("returns empty list when no personal providers exist", async () => {
    const fixture = await trackUsers(
      Promise.resolve(uniqueOrgUser("zmmp-list-empty")),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.modelProviders).toStrictEqual([]);
  });

  it("lists only the current user's model-first personal providers", async () => {
    const fixture = await trackUsers(
      Promise.resolve(uniqueOrgUser("zmmp-list-user")),
    );
    await trackOrg(Promise.resolve({ orgId: fixture.orgId }));
    await store.set(
      seedOrgModelProvider$,
      {
        orgId: fixture.orgId,
        type: "claude-code-oauth-token",
        isDefault: true,
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      context.signal,
    );
    await store.set(
      seedUserModelProvider$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        type: "anthropic-api-key",
        isDefault: true,
        secretName: "ANTHROPIC_API_KEY",
      },
      context.signal,
    );
    await store.set(
      seedUserModelProvider$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        type: "claude-code-oauth-token",
        isDefault: false,
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.modelProviders).toHaveLength(1);
    expect(response.body.modelProviders[0]?.type).toBe(
      "claude-code-oauth-token",
    );
  });

  it("does not list another user's model-first provider in the same organization", async () => {
    const orgId = `org_zmmp_list_cross_${randomUUID().slice(0, 8)}`;
    const alice = await trackUsers(
      Promise.resolve({
        orgId,
        userId: `user_alice_${randomUUID().slice(0, 8)}`,
      }),
    );
    const bob = await trackUsers(
      Promise.resolve({
        orgId,
        userId: `user_bob_${randomUUID().slice(0, 8)}`,
      }),
    );
    const aliceProvider = await store.set(
      seedUserModelProvider$,
      {
        orgId,
        userId: alice.userId,
        type: "claude-code-oauth-token",
        isDefault: false,
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      context.signal,
    );
    const bobProvider = await store.set(
      seedUserModelProvider$,
      {
        orgId,
        userId: bob.userId,
        type: "claude-code-oauth-token",
        isDefault: false,
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      context.signal,
    );
    mocks.clerk.session(alice.userId, orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.modelProviders).toHaveLength(1);
    expect(response.body.modelProviders[0]?.id).toBe(aliceProvider.id);
    expect(response.body.modelProviders[0]?.id).not.toBe(bobProvider.id);

    mocks.clerk.session(bob.userId, orgId);
    const bobResponse = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(bobResponse.body.modelProviders).toHaveLength(1);
    expect(bobResponse.body.modelProviders[0]?.id).toBe(bobProvider.id);
    expect(bobResponse.body.modelProviders[0]?.id).not.toBe(aliceProvider.id);
  });
});
