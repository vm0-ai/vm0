import { randomUUID } from "node:crypto";
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

// BDD migration of the legacy
// `zero-me-model-providers-delete.test.ts`. The 5 legacy `it()`s
// collapse into 2 BDD `it()`s: (1) auth boundary chain (401
// unauth → 401 no-org), (2) full delete chain (204 deletes
// user's provider + secret → 404 on missing provider → 404 on
// cross-user — alice's provider is not deleted even when bob
// issues the delete in the same org).
//
// Service-Level Exception: model providers + secrets are
// seeded directly via `writeDb$` because no public route
// creates a model provider. Post-delete verification uses
// direct DB reads against `model_providers` and `secrets` (no
// follow-up GET list endpoint exists for these resources).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroPersonalModelProvidersByTypeContract);
}

const track = createFixtureTracker<UserModelProviderFixture>((fixture) => {
  return store.set(deleteUserModelProviders$, fixture, context.signal);
});

describe("BDD DELETE /api/zero/me/model-providers/:type — auth boundary", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org", async () => {
    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      client().delete({
        params: { type: "anthropic-api-key" },
        headers: {},
      }),
      [401],
    );
    expect(noAuth.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    // Given: a session that resolves to a user without an org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(
      client().delete({
        params: { type: "anthropic-api-key" },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });
});

describe("BDD DELETE /api/zero/me/model-providers/:type — full delete chain", () => {
  it("gwt-wt-wt: 204 deletes user's provider + secret → 404 on missing provider → 404 on cross-user (alice's provider not deleted by bob)", async () => {
    // Given: a user with a claude-code-oauth-token personal
    // provider.
    const fixture: UserModelProviderFixture = {
      orgId: `org_${randomUUID().slice(0, 8)}`,
      userId: `user_${randomUUID().slice(0, 8)}`,
    };
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

    // When: delete the provider.
    const deleted = await client().delete({
      params: { type: "claude-code-oauth-token" },
      headers: authHeaders(),
    });

    // Then: 204 + both rows are gone.
    expect(deleted.status).toBe(204);
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

    // Given: a fresh user with no providers of the
    // requested type.
    const missingFixture: UserModelProviderFixture = {
      orgId: `org_${randomUUID().slice(0, 8)}`,
      userId: `user_${randomUUID().slice(0, 8)}`,
    };
    await track(Promise.resolve(missingFixture));
    mocks.clerk.session(missingFixture.userId, missingFixture.orgId);

    // When + Then: 404 — Resource not found.
    const missing = await accept(
      client().delete({
        params: { type: "claude-code-oauth-token" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });

    // Given: alice + bob in the same org, only alice has a
    // claude-code-oauth-token provider.
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const alice: UserModelProviderFixture = {
      orgId,
      userId: `user_alice_${randomUUID().slice(0, 8)}`,
    };
    const bob: UserModelProviderFixture = {
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

    // When + Then: bob's delete is 404 — alice's provider
    // is not visible to bob.
    const crossUser = await accept(
      client().delete({
        params: { type: "claude-code-oauth-token" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUser.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });

    // Then: alice's provider + secret are still present.
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
