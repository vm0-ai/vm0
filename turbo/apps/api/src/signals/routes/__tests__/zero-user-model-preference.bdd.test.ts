import { randomUUID } from "node:crypto";

import { zeroUserModelPreferenceContract } from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { createStore, command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-user-model-preference.test.ts`.
// The 12 legacy `it()`s collapse into 3 BDD `it()`s: (1) GET
// chain (401 unauth → 401 no-org → 200 null defaults → 200
// persisted selected model), (2) PUT auth + 400 chain (401
// unauth → 401 no-org → 400 empty body via raw app → 400
// removed-model body via raw app), (3) PUT 200/400 success
// chain (400 unsupported model + no row written → 200 creates
// preference + GET echoes → 200 clears existing preference).
//
// Service-Level Exception: the orgMembersMetadata row is
// seeded directly via `writeDb$` because no public route
// creates it (the public PUT can create it, but the seed is
// also used for tests that start with no preference). The
// 400 invalid-body cases use the raw public app because the
// ts-rest client validates the body client-side and never
// reaches the route.

interface UserModelPreferenceFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface UserModelPreferenceSeedValues {
  readonly selectedModel?: string | null;
  readonly updatedAt?: Date;
}

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const seedUserModelPreferenceFixture$ = command(
  async (
    { set },
    values: UserModelPreferenceSeedValues,
    signal: AbortSignal,
  ): Promise<UserModelPreferenceFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const writeDb = set(writeDb$);

    if ("selectedModel" in values) {
      await writeDb.insert(orgMembersMetadata).values({
        orgId,
        userId,
        selectedModel: values.selectedModel ?? null,
        updatedAt: values.updatedAt,
      });
      signal.throwIfAborted();
    }

    return { orgId, userId };
  },
);

const deleteUserModelPreferenceFixture$ = command(
  async (
    { set },
    fixture: UserModelPreferenceFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);

    await writeDb
      .delete(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, fixture.orgId),
          eq(orgMembersMetadata.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    await writeDb
      .delete(orgModelPolicies)
      .where(eq(orgModelPolicies.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);

const track = createFixtureTracker<UserModelPreferenceFixture>((fixture) => {
  return store.set(deleteUserModelPreferenceFixture$, fixture, context.signal);
});

function apiClient() {
  return setupApp({ context })(zeroUserModelPreferenceContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function seedFixture(
  values: UserModelPreferenceSeedValues = {},
): Promise<UserModelPreferenceFixture> {
  return track(
    store.set(seedUserModelPreferenceFixture$, values, context.signal),
  );
}

describe("BDD GET /api/zero/user-model-preference — auth + 200 chain", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org → 200 null defaults → 200 persisted selected model", async () => {
    const client = apiClient();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(client.get({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    // Given: a fresh fixture with no org in the session.
    const noOrgFx = await seedFixture();
    mocks.clerk.session(noOrgFx.userId, null);

    // When + Then: still 401.
    const noOrg = await accept(client.get({ headers: authHeaders() }), [401]);
    expect(noOrg.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    // Given: a fresh fixture with an org but no preference
    // row.
    const defaultsFx = await seedFixture();
    mocks.clerk.session(defaultsFx.userId, defaultsFx.orgId);

    // When + Then: 200 with null defaults.
    const defaults = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );
    expect(defaults.body).toStrictEqual({
      selectedModel: null,
      updatedAt: null,
    });

    // Given: a fixture with a persisted selected model.
    const updatedAt = new Date("2026-01-02T03:04:05.000Z");
    const persistedFx = await seedFixture({
      selectedModel: "claude-sonnet-4-6",
      updatedAt,
    });
    mocks.clerk.session(persistedFx.userId, persistedFx.orgId);

    // When + Then: 200 with the persisted preference.
    const persisted = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );
    expect(persisted.body).toStrictEqual({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: updatedAt.toISOString(),
    });
  });
});

describe("BDD PUT /api/zero/user-model-preference — auth + 400 chain", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org → 400 empty body via raw app → 400 removed-model body via raw app", async () => {
    const client = apiClient();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      client.update({
        headers: {},
        body: { selectedModel: "claude-sonnet-4-6" },
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    // Given: a fresh fixture with no org in the session.
    const noOrgFx = await seedFixture();
    mocks.clerk.session(noOrgFx.userId, null);

    // When + Then: still 401.
    const noOrg = await accept(
      client.update({
        headers: authHeaders(),
        body: { selectedModel: "claude-sonnet-4-6" },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    // Given: a fixture with an org.
    const badBodyFx = await seedFixture();
    mocks.clerk.session(badBodyFx.userId, badBodyFx.orgId);

    // When + Then: 400 on an empty body via raw app.
    const app = createApp({ signal: context.signal });
    const emptyBody = await app.request("/api/zero/user-model-preference", {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(emptyBody.status).toBe(400);
    await expect(emptyBody.json()).resolves.toStrictEqual({
      error: {
        message: expect.stringContaining("selectedModel: Invalid option"),
        code: "BAD_REQUEST",
      },
    });

    // When + Then: 400 on a removed-model body via raw app.
    const removedBody = await app.request("/api/zero/user-model-preference", {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ selectedModel: "claude-haiku-4-5" }),
    });
    expect(removedBody.status).toBe(400);
    await expect(removedBody.json()).resolves.toStrictEqual({
      error: {
        message: expect.stringContaining("selectedModel: Invalid option"),
        code: "BAD_REQUEST",
      },
    });
  });
});

describe("BDD PUT /api/zero/user-model-preference — 200/400 success chain", () => {
  it("gwt-wt-wt: 400 unsupported model + no row written → 200 creates preference + GET echoes → 200 clears existing preference", async () => {
    const client = apiClient();

    // Given: a fresh fixture with an org.
    const unsupportedFx = await seedFixture();
    mocks.clerk.session(unsupportedFx.userId, unsupportedFx.orgId);

    // When + Then: 400 — unsupported model; GET still returns
    // null defaults (no row written).
    const unsupported = await accept(
      client.update({
        headers: authHeaders(),
        body: { selectedModel: "gpt-5.4" },
      }),
      [400],
    );
    expect(unsupported.body).toStrictEqual({
      error: {
        message: "Invalid request",
        code: "BAD_REQUEST",
      },
    });
    const noRow = await accept(client.get({ headers: authHeaders() }), [200]);
    expect(noRow.body).toStrictEqual({
      selectedModel: null,
      updatedAt: null,
    });

    // Given: a fresh fixture with an org.
    const createFx = await seedFixture();
    mocks.clerk.session(createFx.userId, createFx.orgId);

    // When: PUT a supported model.
    const created = await accept(
      client.update({
        headers: authHeaders(),
        body: { selectedModel: "claude-sonnet-4-6" },
      }),
      [200],
    );

    // Then: 200 + GET echoes the same body.
    expect(created.body.selectedModel).toBe("claude-sonnet-4-6");
    expect(created.body.updatedAt).toStrictEqual(expect.any(String));
    const echoed = await accept(client.get({ headers: authHeaders() }), [200]);
    expect(echoed.body).toStrictEqual(created.body);

    // Given: a fixture with an existing preference.
    const clearFx = await seedFixture({
      selectedModel: "claude-sonnet-4-6",
    });
    mocks.clerk.session(clearFx.userId, clearFx.orgId);

    // When: PUT null.
    const cleared = await accept(
      client.update({
        headers: authHeaders(),
        body: { selectedModel: null },
      }),
      [200],
    );

    // Then: 200 + GET reflects the cleared preference.
    expect(cleared.body).toStrictEqual({
      selectedModel: null,
      updatedAt: null,
    });
    const after = await accept(client.get({ headers: authHeaders() }), [200]);
    expect(after.body).toStrictEqual({
      selectedModel: null,
      updatedAt: null,
    });
  });
});
