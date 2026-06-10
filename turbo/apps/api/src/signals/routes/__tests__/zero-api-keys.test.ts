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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

describe("GET /api/zero/api-keys", () => {
  const track = createFixtureTracker<ApiKeysFixture>((fixture) => {
    return store.set(deleteApiKeys$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(apiKeysContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns the current user's API keys sorted by creation time", async () => {
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context })(apiKeysContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.apiKeys).toHaveLength(2);
    expect(response.body.apiKeys).toMatchObject([
      {
        name: "Newer",
        tokenPrefix: "vm0_pat_newe\u2026",
        createdAt: "2026-03-02T00:00:00.000Z",
        expiresAt: "2026-04-02T00:00:00.000Z",
        lastUsedAt: "2026-03-03T00:00:00.000Z",
      },
      {
        name: "Older",
        tokenPrefix: "vm0_pat_olde\u2026",
        createdAt: "2026-03-01T00:00:00.000Z",
        expiresAt: "2026-04-01T00:00:00.000Z",
        lastUsedAt: null,
      },
    ]);
  });

  it("returns an empty list when the user has no API keys", async () => {
    const fixture = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context })(apiKeysContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ apiKeys: [] });
  });

  it("list excludes the full token and only exposes the prefix", async () => {
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context })(apiKeysContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.apiKeys).toStrictEqual([
      {
        id: expect.any(String),
        name: "Deploy key",
        tokenPrefix: "vm0_pat_depl\u2026",
        createdAt: "2026-03-04T00:00:00.000Z",
        expiresAt: "2026-04-04T00:00:00.000Z",
        lastUsedAt: null,
      },
    ]);
  });
});

describe("POST /api/zero/api-keys", () => {
  const track = createFixtureTracker<ApiKeysFixture>((fixture) => {
    return store.set(deleteApiKeys$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(apiKeysContract);

    const response = await client.create({
      headers: {},
      body: { name: "CI bot", expiresInDays: 90 },
    });

    expect(response.status).toBe(401);
    if (response.status !== 401) {
      throw new Error(`Expected 401, received ${response.status}`);
    }
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 when the request has no active organization", async () => {
    const fixture = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(fixture.userId, null);
    const client = setupApp({ context })(apiKeysContract);

    const response = await client.create({
      headers: authHeaders(),
      body: { name: "CI bot", expiresInDays: 90 },
    });

    expect(response.status).toBe(400);
    if (response.status !== 400) {
      throw new Error(`Expected 400, received ${response.status}`);
    }
    expect(response.body).toStrictEqual({
      error: {
        message:
          "Explicit org context required \u2014 ensure active org in session",
        code: "BAD_REQUEST",
      },
    });
  });

  it("creates a new PAT and returns the full token exactly once", async () => {
    const fixture = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(fixture.userId, `org_${randomUUID().slice(0, 8)}`);
    const client = setupApp({ context })(apiKeysContract);

    const response = await client.create({
      headers: authHeaders(),
      body: { name: "CI bot", expiresInDays: 90 },
    });

    expect(response.status).toBe(201);
    if (response.status !== 201) {
      throw new Error(`Expected 201, received ${response.status}`);
    }
    expect(response.body).toMatchObject({
      id: expect.any(String),
      name: "CI bot",
      token: expect.stringMatching(/^vm0_pat_/),
      tokenPrefix: expect.stringMatching(/^vm0_pat_.+\u2026$/),
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
      lastUsedAt: null,
    });
    expect(response.body.tokenPrefix).toBe(
      `${response.body.token.slice(0, 12)}\u2026`,
    );
    expect(
      new Date(response.body.expiresAt).getTime() -
        new Date(response.body.createdAt).getTime(),
    ).toBe(90 * MS_PER_DAY);

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select()
      .from(cliTokens)
      .where(eq(cliTokens.id, response.body.id));

    expect(row).toBeDefined();
    expect(row?.userId).toBe(fixture.userId);
    expect(row?.name).toBe("CI bot");
    expect(row?.token).toBe(response.body.token);
  });

  it("rejects an empty name", async () => {
    const fixture = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(fixture.userId, `org_${randomUUID().slice(0, 8)}`);
    const client = setupApp({ context })(apiKeysContract);

    const response = await client.create({
      headers: authHeaders(),
      body: { name: "", expiresInDays: 90 },
    });

    expect(response.status).toBe(400);
    if (response.status !== 400) {
      throw new Error(`Expected 400, received ${response.status}`);
    }
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects a non-positive expiresInDays", async () => {
    const fixture = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(fixture.userId, `org_${randomUUID().slice(0, 8)}`);
    const client = setupApp({ context })(apiKeysContract);

    const response = await client.create({
      headers: authHeaders(),
      body: { name: "CI bot", expiresInDays: 0 },
    });

    expect(response.status).toBe(400);
    if (response.status !== 400) {
      throw new Error(`Expected 400, received ${response.status}`);
    }
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects expiresInDays above the 10-year cap", async () => {
    const fixture = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(fixture.userId, `org_${randomUUID().slice(0, 8)}`);
    const client = setupApp({ context })(apiKeysContract);

    const response = await client.create({
      headers: authHeaders(),
      body: { name: "CI bot", expiresInDays: 4000 },
    });

    expect(response.status).toBe(400);
    if (response.status !== 400) {
      throw new Error(`Expected 400, received ${response.status}`);
    }
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("list excludes the full token after creation", async () => {
    const fixture = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(fixture.userId, `org_${randomUUID().slice(0, 8)}`);
    const client = setupApp({ context })(apiKeysContract);

    const created = await client.create({
      headers: authHeaders(),
      body: { name: "Deploy key", expiresInDays: 30 },
    });
    expect(created.status).toBe(201);
    if (created.status !== 201) {
      throw new Error(`Expected 201, received ${created.status}`);
    }

    const listed = await client.list({ headers: authHeaders() });
    expect(listed.status).toBe(200);
    if (listed.status !== 200) {
      throw new Error(`Expected 200, received ${listed.status}`);
    }
    const apiKeys: readonly ApiKeyItem[] = listed.body.apiKeys;
    const found = apiKeys.find((apiKey) => {
      return apiKey.id === created.body.id;
    });

    expect(found).toStrictEqual({
      id: created.body.id,
      name: "Deploy key",
      tokenPrefix: created.body.tokenPrefix,
      createdAt: created.body.createdAt,
      expiresAt: created.body.expiresAt,
      lastUsedAt: null,
    });
    expect(Object.keys(found ?? {})).not.toContain("token");
  });
});
