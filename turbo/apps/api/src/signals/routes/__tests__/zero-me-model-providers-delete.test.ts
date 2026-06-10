import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import {
  zeroPersonalModelProvidersByTypeContract,
  zeroPersonalModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { secrets } from "@vm0/db/schema/secret";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteUserModelProviders$,
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

async function listPersonalModelProviders() {
  const client = setupApp({ context })(zeroPersonalModelProvidersMainContract);
  const response = await accept(
    client.list({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  return response.body.modelProviders;
}

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

  it("deletes the user's personal provider and removes it from list", async () => {
    const fixture = uniqueOrgUser("zmmp-delete");
    await track(Promise.resolve(fixture));
    await store.set(
      seedUserModelProvider$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        type: "claude-code-oauth-token",
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const beforeDelete = await listPersonalModelProviders();
    expect(beforeDelete).toHaveLength(1);
    expect(beforeDelete[0]).toMatchObject({
      type: "claude-code-oauth-token",
      secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    });

    const client = setupApp({ context })(
      zeroPersonalModelProvidersByTypeContract,
    );
    const response = await client.delete({
      params: { type: "claude-code-oauth-token" },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(204);

    const afterDelete = await listPersonalModelProviders();
    expect(afterDelete).toStrictEqual([]);

    // Internal storage assertion covers the hidden single-secret cascade.
    const writeDb = store.set(writeDb$);
    const remainingSecrets = await writeDb
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
          eq(secrets.name, "CLAUDE_CODE_OAUTH_TOKEN"),
        ),
      );
    expect(remainingSecrets).toStrictEqual([]);
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
    await store.set(
      seedUserModelProvider$,
      {
        orgId,
        userId: alice.userId,
        type: "claude-code-oauth-token",
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      context.signal,
    );
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

    const bobProviders = await listPersonalModelProviders();
    expect(bobProviders).toStrictEqual([]);

    mocks.clerk.session(alice.userId, orgId);
    const aliceProviders = await listPersonalModelProviders();
    expect(aliceProviders).toHaveLength(1);
    expect(aliceProviders[0]).toMatchObject({
      type: "claude-code-oauth-token",
      secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    });
  });
});
