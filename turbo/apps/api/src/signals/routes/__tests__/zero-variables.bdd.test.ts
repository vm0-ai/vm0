import { randomUUID } from "node:crypto";

import { zeroVariablesContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { variables } from "@vm0/db/schema/variable";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUserData$,
  seedOtherVariable$,
  seedVariables$,
  type UserDataFixture,
} from "./helpers/zero-user-data";

// BDD migration of the legacy `zero-variables.test.ts`. The
// 10 legacy `it()`s collapse into 3 BDD `it()`s: (1) GET
// chain (401 unauth → 401 no-org → 200 sorted list → 200
// empty list → 200 connector-owned variables are hidden),
// (2) POST auth + 400 chain (401 unauth → 400 invalid name),
// (3) POST 200 success chain (200 creates → 200 updates an
// existing variable without duplicating → 200 only the
// user-owned variable is updated when a connector-owned one
// shares the name).
//
// Service-Level Exception: `variables` rows are seeded
// directly via `writeDb$` (via `seedVariables$` and
// `seedOtherVariable$`) because no public route creates
// them out of band. Post-write verification for the
// connector-owned-overlap case uses a direct DB read
// against the `variables` table.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const track = createFixtureTracker<UserDataFixture>((fixture) => {
  return store.set(deleteUserData$, fixture, context.signal);
});

function client() {
  return setupApp({ context })(zeroVariablesContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("BDD GET /api/zero/variables — auth + 200 chain", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org → 200 sorted list → 200 empty list → 200 connector-owned variables are hidden", async () => {
    const c = client();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(c.list({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with a user but no org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(c.list({ headers: authHeaders() }), [401]);
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a user with two variables + another user-scoped
    // variable that must not appear in the listing.
    const createdAt = new Date("2026-02-02T03:04:05.000Z");
    const updatedAt = new Date("2026-02-03T03:04:05.000Z");
    const fixture = await track(
      store.set(
        seedVariables$,
        [
          {
            name: "Z_REGION",
            value: "us-west-2",
            description: null,
            createdAt,
            updatedAt,
          },
          {
            name: "A_ENDPOINT",
            value: "https://api.example.test",
            description: "endpoint",
            createdAt,
            updatedAt,
          },
        ],
        context.signal,
      ),
    );
    await store.set(seedOtherVariable$, fixture, context.signal);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 200 with the two variables sorted by name
    // and timestamps.
    const sorted = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(sorted.body.variables).toHaveLength(2);
    expect(sorted.body.variables).toMatchObject([
      {
        name: "A_ENDPOINT",
        value: "https://api.example.test",
        description: "endpoint",
        createdAt: "2026-02-02T03:04:05.000Z",
        updatedAt: "2026-02-03T03:04:05.000Z",
      },
      {
        name: "Z_REGION",
        value: "us-west-2",
        description: null,
        createdAt: "2026-02-02T03:04:05.000Z",
        updatedAt: "2026-02-03T03:04:05.000Z",
      },
    ]);

    // Given: a fresh user with no variables.
    const emptyFx = await track(store.set(seedVariables$, [], context.signal));
    mocks.clerk.session(emptyFx.userId, emptyFx.orgId);

    // When + Then: 200 with an empty list.
    const empty = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(empty.body).toStrictEqual({ variables: [] });

    // Given: a user with a user-owned + a connector-owned
    // variable sharing the org.
    const connectorFx = await track(
      store.set(
        seedVariables$,
        [
          { name: "USER_VISIBLE", value: "user-value" },
          {
            name: "CONNECTOR_INTERNAL",
            value: "connector-value",
            type: "connector",
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(connectorFx.userId, connectorFx.orgId);

    // When + Then: 200 — connector-owned variable is hidden.
    const filtered = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(filtered.body.variables).toMatchObject([
      { name: "USER_VISIBLE", value: "user-value" },
    ]);
  });
});

describe("BDD POST /api/zero/variables — auth + 400 chain", () => {
  it("gwt-wt-wt: 401 unauth → 400 invalid name", async () => {
    const c = client();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      c.set({
        headers: {},
        body: {
          name: "MY_VARIABLE",
          value: "variable-value-123",
        },
      }),
      [401],
    );
    expect(noAuth).toMatchObject({
      status: 401,
      body: {
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      },
    });

    // Given: a fresh user with no variables.
    const badNameFx = await track(
      store.set(seedVariables$, [], context.signal),
    );
    mocks.clerk.session(badNameFx.userId, badNameFx.orgId);

    // When + Then: 400 on an invalid variable name.
    const badName = await accept(
      c.set({
        headers: authHeaders(),
        body: {
          name: "invalid name with spaces",
          value: "variable-value-123",
        },
      }),
      [400],
    );
    expect(badName).toMatchObject({
      body: { error: { code: "BAD_REQUEST" } },
    });
  });
});

describe("BDD POST /api/zero/variables — 200 success chain", () => {
  it("gwt-wt-wt: 200 creates → 200 updates an existing variable without duplicating → 200 only the user-owned variable is updated when a connector-owned one shares the name", async () => {
    const c = client();

    // Given: a fresh user with no variables.
    const createFx = await track(store.set(seedVariables$, [], context.signal));
    mocks.clerk.session(createFx.userId, createFx.orgId);

    // When + Then: 200 + the new variable is created.
    const created = await accept(
      c.set({
        headers: authHeaders(),
        body: {
          name: "MY_VARIABLE",
          value: "variable-value-123",
          description: "Test variable",
        },
      }),
      [200],
    );
    expect(created).toMatchObject({
      body: {
        id: expect.any(String),
        name: "MY_VARIABLE",
        value: "variable-value-123",
        description: "Test variable",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    });

    // Given: a user with an existing MY_VARIABLE.
    const updateFx = await track(
      store.set(
        seedVariables$,
        [
          {
            name: "MY_VARIABLE",
            value: "value-v1",
            description: null,
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(updateFx.userId, updateFx.orgId);

    // When: PUT the same name with a new value.
    const updated = await accept(
      c.set({
        headers: authHeaders(),
        body: {
          name: "MY_VARIABLE",
          value: "value-v2",
          description: "Updated description",
        },
      }),
      [200],
    );

    // Then: 200 + the row is updated (no duplicate).
    expect(updated).toMatchObject({
      body: {
        name: "MY_VARIABLE",
        value: "value-v2",
        description: "Updated description",
      },
    });
    const listAfterUpdate = await accept(
      c.list({ headers: authHeaders() }),
      [200],
    );
    expect(listAfterUpdate).toMatchObject({
      body: {
        variables: [
          {
            name: "MY_VARIABLE",
            value: "value-v2",
            description: "Updated description",
          },
        ],
      },
    });

    // Given: a user with only a connector-owned SHARED_NAME.
    const sharedFx = await track(
      store.set(
        seedVariables$,
        [
          {
            name: "SHARED_NAME",
            value: "connector-value",
            type: "connector",
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(sharedFx.userId, sharedFx.orgId);

    // When: POST the same name.
    await accept(
      c.set({
        headers: authHeaders(),
        body: {
          name: "SHARED_NAME",
          value: "user-value",
        },
      }),
      [200],
    );

    // Then: both the connector-owned and the user-owned rows
    // exist side-by-side (the connector-owned row is
    // untouched).
    const writeDb = store.set(writeDb$);
    const rows = await writeDb
      .select({
        name: variables.name,
        value: variables.value,
        type: variables.type,
      })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, sharedFx.orgId),
          eq(variables.userId, sharedFx.userId),
          eq(variables.name, "SHARED_NAME"),
        ),
      )
      .orderBy(variables.type);
    expect(rows).toStrictEqual([
      { name: "SHARED_NAME", value: "connector-value", type: "connector" },
      { name: "SHARED_NAME", value: "user-value", type: "user" },
    ]);
  });
});
