import { randomUUID } from "node:crypto";

import {
  apiKeysContract,
  type ApiKeyItem,
} from "@vm0/api-contracts/contracts/api-keys";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteApiKeys$,
  seedApiKeys$,
  type ApiKeysFixture,
} from "./helpers/zero-api-keys";

// BDD migration of the legacy `zero-api-keys.test.ts`. The
// 11 legacy `it()`s collapse into 3 BDD `it()`s: (1) GET
// chain (401 unauth → 200 sorted list → 200 empty list →
// 200 list excludes the full token), (2) POST auth + 400
// chain (401 unauth → 400 no active org → 400 empty name →
// 400 non-positive expiresInDays → 400 expiresInDays above
// 10-year cap), (3) POST 201 success chain (201 creates a
// new PAT with full token returned exactly once + DB row
// written → 200 list excludes the full token after creation).
//
// Service-Level Exception: `cliTokens` rows are read
// directly via `writeDb$` because no public follow-up GET
// endpoint exists for a single API key row.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

describe("BDD GET /api/zero/api-keys — auth + 200 chain", () => {
  const track = createFixtureTracker<ApiKeysFixture>((fixture) => {
    return store.set(deleteApiKeys$, fixture, context.signal);
  });

  it("gwt-wt-wt: 401 unauth → 200 sorted list → 200 empty list → 200 list excludes the full token", async () => {
    const client = setupApp({ context })(apiKeysContract);

    // When + Then: 401 — no auth header.
    const noAuth = await accept(client.list({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a user with two API keys + a different user
    // with one API key (must be excluded).
    const sortedFx = await track(
      store.set(
        seedApiKeys$,
        [
          {
            name: "Older",
            token: "vm0_pat_older_token",
            createdAt: new Date("2026-03-01T00:00:00.000Z"),
            expiresAt: new Date("2026-04-01T00:00:00.000Z"),
          },
          {
            name: "Newer",
            token: "vm0_pat_newer_token",
            createdAt: new Date("2026-03-02T00:00:00.000Z"),
            expiresAt: new Date("2026-04-02T00:00:00.000Z"),
            lastUsedAt: new Date("2026-03-03T00:00:00.000Z"),
          },
        ],
        context.signal,
      ),
    );
    await track(
      store.set(
        seedApiKeys$,
        [
          {
            name: "Other user",
            token: "vm0_pat_other_token",
            createdAt: new Date("2026-03-03T00:00:00.000Z"),
            expiresAt: new Date("2026-04-03T00:00:00.000Z"),
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(sortedFx.userId, null);

    // When + Then: 200 — sorted list (newest first) with
    // token prefix only.
    const sorted = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    expect(sorted.body.apiKeys).toHaveLength(2);
    expect(sorted.body.apiKeys).toMatchObject([
      {
        name: "Newer",
        tokenPrefix: "vm0_pat_newe…",
        createdAt: "2026-03-02T00:00:00.000Z",
        expiresAt: "2026-04-02T00:00:00.000Z",
        lastUsedAt: "2026-03-03T00:00:00.000Z",
      },
      {
        name: "Older",
        tokenPrefix: "vm0_pat_olde…",
        createdAt: "2026-03-01T00:00:00.000Z",
        expiresAt: "2026-04-01T00:00:00.000Z",
        lastUsedAt: null,
      },
    ]);

    // Given: a fresh user with no API keys.
    const emptyFx = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(emptyFx.userId, null);

    // When + Then: 200 — empty list.
    const empty = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    expect(empty.body).toStrictEqual({ apiKeys: [] });

    // Given: a fresh user with a single deploy key.
    const deployFx = await track(
      store.set(
        seedApiKeys$,
        [
          {
            name: "Deploy key",
            token: "vm0_pat_deploy_key_full_token_value",
            createdAt: new Date("2026-03-04T00:00:00.000Z"),
            expiresAt: new Date("2026-04-04T00:00:00.000Z"),
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(deployFx.userId, null);

    // When + Then: 200 — the response only exposes the
    // token prefix, not the full token.
    const deploy = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    expect(deploy.body.apiKeys).toStrictEqual([
      {
        id: expect.any(String),
        name: "Deploy key",
        tokenPrefix: "vm0_pat_depl…",
        createdAt: "2026-03-04T00:00:00.000Z",
        expiresAt: "2026-04-04T00:00:00.000Z",
        lastUsedAt: null,
      },
    ]);
  });
});

describe("BDD POST /api/zero/api-keys — auth + 400 chain", () => {
  const track = createFixtureTracker<ApiKeysFixture>((fixture) => {
    return store.set(deleteApiKeys$, fixture, context.signal);
  });

  it("gwt-wt-wt: 401 unauth → 400 no active org → 400 empty name → 400 non-positive expiresInDays → 400 expiresInDays above 10-year cap", async () => {
    const client = setupApp({ context })(apiKeysContract);

    // When + Then: 401 — no auth header.
    const noAuth = await client.create({
      headers: {},
      body: { name: "CI bot", expiresInDays: 90 },
    });
    expect(noAuth.status).toBe(401);
    if (noAuth.status !== 401) {
      throw new Error(`Expected 401, received ${noAuth.status}`);
    }
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fresh user with no API keys + no org session.
    const noOrgFx = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(noOrgFx.userId, null);

    // When + Then: 400 — explicit org context required.
    const noOrg = await client.create({
      headers: authHeaders(),
      body: { name: "CI bot", expiresInDays: 90 },
    });
    expect(noOrg.status).toBe(400);
    if (noOrg.status !== 400) {
      throw new Error(`Expected 400, received ${noOrg.status}`);
    }
    expect(noOrg.body).toStrictEqual({
      error: {
        message:
          "Explicit org context required — ensure active org in session",
        code: "BAD_REQUEST",
      },
    });

    // Given: a fresh user with an org session.
    const emptyNameFx = await track(
      store.set(seedApiKeys$, [], context.signal),
    );
    mocks.clerk.session(
      emptyNameFx.userId,
      `org_${randomUUID().slice(0, 8)}`,
    );

    // When + Then: 400 — empty name.
    const emptyName = await client.create({
      headers: authHeaders(),
      body: { name: "", expiresInDays: 90 },
    });
    expect(emptyName.status).toBe(400);
    if (emptyName.status !== 400) {
      throw new Error(`Expected 400, received ${emptyName.status}`);
    }
    expect(emptyName.body.error.code).toBe("BAD_REQUEST");

    // Given: a fresh user with an org session.
    const zeroDaysFx = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(zeroDaysFx.userId, `org_${randomUUID().slice(0, 8)}`);

    // When + Then: 400 — non-positive expiresInDays.
    const zeroDays = await client.create({
      headers: authHeaders(),
      body: { name: "CI bot", expiresInDays: 0 },
    });
    expect(zeroDays.status).toBe(400);
    if (zeroDays.status !== 400) {
      throw new Error(`Expected 400, received ${zeroDays.status}`);
    }
    expect(zeroDays.body.error.code).toBe("BAD_REQUEST");

    // Given: a fresh user with an org session.
    const longDaysFx = await track(
      store.set(seedApiKeys$, [], context.signal),
    );
    mocks.clerk.session(longDaysFx.userId, `org_${randomUUID().slice(0, 8)}`);

    // When + Then: 400 — expiresInDays above the 10-year cap.
    const longDays = await client.create({
      headers: authHeaders(),
      body: { name: "CI bot", expiresInDays: 4000 },
    });
    expect(longDays.status).toBe(400);
    if (longDays.status !== 400) {
      throw new Error(`Expected 400, received ${longDays.status}`);
    }
    expect(longDays.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("BDD POST /api/zero/api-keys — 201 success chain", () => {
  const track = createFixtureTracker<ApiKeysFixture>((fixture) => {
    return store.set(deleteApiKeys$, fixture, context.signal);
  });

  it("gwt-wt-wt: 201 creates a new PAT with full token returned exactly once + DB row written → 200 list excludes the full token after creation", async () => {
    const client = setupApp({ context })(apiKeysContract);

    // Given: a fresh user with an org session.
    const createFx = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(createFx.userId, `org_${randomUUID().slice(0, 8)}`);

    // When: create a new PAT.
    const created = await client.create({
      headers: authHeaders(),
      body: { name: "CI bot", expiresInDays: 90 },
    });

    // Then: 201 + the response carries the full token +
    // tokenPrefix matches the first 12 chars + 90-day
    // expiry.
    expect(created.status).toBe(201);
    if (created.status !== 201) {
      throw new Error(`Expected 201, received ${created.status}`);
    }
    expect(created.body).toMatchObject({
      id: expect.any(String),
      name: "CI bot",
      token: expect.stringMatching(/^vm0_pat_/),
      tokenPrefix: expect.stringMatching(/^vm0_pat_.+…$/),
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
      lastUsedAt: null,
    });
    expect(created.body.tokenPrefix).toBe(
      `${created.body.token.slice(0, 12)}…`,
    );
    expect(
      new Date(created.body.expiresAt).getTime() -
        new Date(created.body.createdAt).getTime(),
    ).toBe(90 * MS_PER_DAY);

    // Then: a `cliTokens` row was persisted with the full
    // token + user id + name.
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select()
      .from(cliTokens)
      .where(eq(cliTokens.id, created.body.id));
    expect(row).toBeDefined();
    expect(row?.userId).toBe(createFx.userId);
    expect(row?.name).toBe("CI bot");
    expect(row?.token).toBe(created.body.token);

    // Given: a fresh user with an org session + a newly
    // created deploy key.
    const listFx = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(listFx.userId, `org_${randomUUID().slice(0, 8)}`);
    const createdDeploy = await client.create({
      headers: authHeaders(),
      body: { name: "Deploy key", expiresInDays: 30 },
    });
    expect(createdDeploy.status).toBe(201);
    if (createdDeploy.status !== 201) {
      throw new Error(`Expected 201, received ${createdDeploy.status}`);
    }

    // When + Then: 200 — the listing shows the new key but
    // does not expose the full token.
    const listed = await client.list({ headers: authHeaders() });
    expect(listed.status).toBe(200);
    if (listed.status !== 200) {
      throw new Error(`Expected 200, received ${listed.status}`);
    }
    const apiKeys: readonly ApiKeyItem[] = listed.body.apiKeys;
    const found = apiKeys.find((apiKey) => {
      return apiKey.id === createdDeploy.body.id;
    });
    expect(found).toStrictEqual({
      id: createdDeploy.body.id,
      name: "Deploy key",
      tokenPrefix: createdDeploy.body.tokenPrefix,
      createdAt: createdDeploy.body.createdAt,
      expiresAt: createdDeploy.body.expiresAt,
      lastUsedAt: null,
    });
    expect(Object.keys(found ?? {})).not.toContain("token");
  });
});
