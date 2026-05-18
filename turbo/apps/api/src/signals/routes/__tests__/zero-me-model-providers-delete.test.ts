import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { zeroPersonalModelProvidersByTypeContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { modelProviders } from "@vm0/db/schema/model-provider";
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

  it("deletes the user's personal provider and removes the row + secret", async () => {
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

    const client = setupApp({ context })(
      zeroPersonalModelProvidersByTypeContract,
    );
    const response = await client.delete({
      params: { type: "claude-code-oauth-token" },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(204);

    // model_provider row removed
    const writeDb = store.set(writeDb$);
    const remaining = await writeDb
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, fixture.orgId),
          eq(modelProviders.userId, fixture.userId),
        ),
      );
    expect(remaining).toStrictEqual([]);

    // secret row also removed (FK cascade for legacy single-secret providers)
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

    const writeDb = store.set(writeDb$);
    const aliceProviders = await writeDb
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, orgId),
          eq(modelProviders.userId, alice.userId),
          eq(modelProviders.type, "claude-code-oauth-token"),
        ),
      );
    expect(aliceProviders).toHaveLength(1);

    const aliceSecrets = await writeDb
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, alice.userId),
          eq(secrets.name, "CLAUDE_CODE_OAUTH_TOKEN"),
        ),
      );
    expect(aliceSecrets).toHaveLength(1);
  });
});
