import { randomUUID } from "node:crypto";
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

// BDD migration of the legacy
// `zero-me-model-providers-list.test.ts`. The 5 legacy `it()`s
// collapse into 3 BDD `it()`s: (1) auth boundary chain (401
// unauth → 401 no-org), (2) 200 empty list chain (no personal
// providers → 200 []), (3) 200 scoped list chain (alice sees
// her own non-default claude-code-oauth-token provider + her
// default anthropic-api-key is filtered out → bob sees his own
// + alice's is not visible to bob in the same org).
//
// Service-Level Exception: providers + secrets are seeded
// directly via `writeDb$` because there is no public route to
// create a model provider (providers are provisioned by the
// connector OAuth flow, not the public API).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroPersonalModelProvidersMainContract);
}

const trackUsers = createFixtureTracker<UserModelProviderFixture>(
  async (fixture) => {
    await store.set(deleteUserModelProviders$, fixture, context.signal);
  },
);
const trackOrg = createFixtureTracker<{ readonly orgId: string }>((fixture) => {
  return store.set(deleteOrgModelProviders$, fixture, context.signal);
});

describe("BDD GET /api/zero/me/model-providers — auth boundary", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org", async () => {
    // When + Then: 401 with no auth header.
    const noAuth = await accept(client().list({ headers: {} }), [401]);
    expect(noAuth.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    // Given: a session that resolves to a user without an org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(
      client().list({ headers: authHeaders() }),
      [401],
    );
    expect(noOrg.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });
});

describe("BDD GET /api/zero/me/model-providers — 200 empty", () => {
  it("gwt-wt-wt: 200 returns empty list when no personal providers exist", async () => {
    // Given: a session for a user with no model providers.
    const fixture = await trackUsers(
      Promise.resolve({
        orgId: `org_${randomUUID().slice(0, 8)}`,
        userId: `user_${randomUUID().slice(0, 8)}`,
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 200 with an empty list.
    const response = await accept(
      client().list({ headers: authHeaders() }),
      [200],
    );
    expect(response.body.modelProviders).toStrictEqual([]);
  });
});

describe("BDD GET /api/zero/me/model-providers — 200 scoped list", () => {
  it("gwt-wt-wt: 200 alice sees only her own claude-code-oauth-token (anthropic-api-key filtered out) → 200 bob sees only his own (alice's is not visible)", async () => {
    // Given: a shared org with two users (alice + bob) and
    // 3 providers — alice's default anthropic-api-key,
    // alice's non-default claude-code-oauth-token, and bob's
    // non-default claude-code-oauth-token.
    const orgId = `org_${randomUUID().slice(0, 8)}`;
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
    await trackOrg(Promise.resolve({ orgId }));
    await store.set(
      seedOrgModelProvider$,
      {
        orgId,
        type: "claude-code-oauth-token",
        isDefault: true,
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      context.signal,
    );
    await store.set(
      seedUserModelProvider$,
      {
        orgId,
        userId: alice.userId,
        type: "anthropic-api-key",
        isDefault: true,
        secretName: "ANTHROPIC_API_KEY",
      },
      context.signal,
    );
    await store.set(
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

    // When + Then: 200 — alice sees only her own
    // claude-code-oauth-token (not the anthropic-api-key).
    const aliceRes = await accept(
      client().list({ headers: authHeaders() }),
      [200],
    );
    expect(aliceRes.body.modelProviders).toHaveLength(1);
    expect(aliceRes.body.modelProviders[0]?.type).toBe(
      "claude-code-oauth-token",
    );

    // Given: bob's session.
    mocks.clerk.session(bob.userId, orgId);

    // When + Then: 200 — bob sees only his own provider; not
    // alice's.
    const bobRes = await accept(
      client().list({ headers: authHeaders() }),
      [200],
    );
    expect(bobRes.body.modelProviders).toHaveLength(1);
    expect(bobRes.body.modelProviders[0]?.id).toBe(bobProvider.id);
  });
});
