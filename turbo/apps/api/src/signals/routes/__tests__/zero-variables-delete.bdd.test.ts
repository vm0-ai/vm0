import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { zeroVariablesByNameContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { variables } from "@vm0/db/schema/variable";

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

// BDD migration of the legacy `zero-variables-delete.test.ts`.
// The 7 legacy `it()`s collapse into 3 BDD `it()`s: (1) auth
// boundary (401 unauth → 401 no-org), (2) 204 success + 404
// chain (204 deletes the variable + row removed → 204 deletes
// only the user-owned variable when a connector-owned one
// shares the name → 404 when only a connector-owned variable
// exists → 404 for a nonexistent variable), (3) 404 isolation
// chain (404 for cross-user with victim intact → 404 for
// cross-org with victim intact).
//
// Service-Level Exception: `variables` rows are seeded directly
// via `writeDb$` (via `seedVariables$` and `seedOtherVariable$`)
// because no public route creates one. Post-delete verification
// uses direct DB reads against the `variables` table since
// there is no follow-up GET endpoint for this resource.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroVariablesByNameContract);
}

const track = createFixtureTracker<UserDataFixture>((fixture) => {
  return store.set(deleteUserData$, fixture, context.signal);
});

describe("BDD DELETE /api/zero/variables/:name — auth boundary", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org", async () => {
    const c = client();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      c.delete({ params: { name: "ANY_VAR" }, headers: {} }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session that resolves to a user without an org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(
      c.delete({ params: { name: "ANY_VAR" }, headers: authHeaders() }),
      [401],
    );
    expect(noOrg.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });
});

describe("BDD DELETE /api/zero/variables/:name — 204 + 404 chain", () => {
  it("gwt-wt-wt: 204 deletes the variable and removes the row → 204 deletes only the user-owned variable when a connector-owned one shares the name → 404 when only a connector-owned variable exists → 404 for a nonexistent variable", async () => {
    const c = client();

    // Given: a user with a DELETE_ME variable.
    const fixture = await track(
      store.set(
        seedVariables$,
        [{ name: "DELETE_ME", value: "to-be-deleted" }],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When: delete the variable.
    const deleted = await c.delete({
      params: { name: "DELETE_ME" },
      headers: authHeaders(),
    });

    // Then: 204 + the row is gone.
    expect(deleted.status).toBe(204);
    const writeDb = store.set(writeDb$);
    const remaining = await writeDb
      .select({ id: variables.id })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, fixture.orgId),
          eq(variables.userId, fixture.userId),
          eq(variables.name, "DELETE_ME"),
        ),
      );
    expect(remaining).toStrictEqual([]);

    // Given: a user with a user-owned SHARED_NAME variable +
    // a connector-owned SHARED_NAME variable.
    const sharedFx = await track(
      store.set(
        seedVariables$,
        [
          { name: "SHARED_NAME", value: "user-value" },
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

    // When + Then: 204 + only the user-owned row is removed;
    // the connector-owned row is preserved.
    const shared = await c.delete({
      params: { name: "SHARED_NAME" },
      headers: authHeaders(),
    });
    expect(shared.status).toBe(204);
    const sharedRemaining = await writeDb
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
      );
    expect(sharedRemaining).toStrictEqual([
      { name: "SHARED_NAME", value: "connector-value", type: "connector" },
    ]);

    // Given: a user with only a connector-owned variable.
    const connectorFx = await track(
      store.set(
        seedVariables$,
        [
          {
            name: "CONNECTOR_ONLY",
            value: "connector-value",
            type: "connector",
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(connectorFx.userId, connectorFx.orgId);

    // When + Then: 404 — the user-secret delete endpoint does
    // not apply to connector-type variables.
    const connector = await accept(
      c.delete({
        params: { name: "CONNECTOR_ONLY" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(connector.body).toMatchObject({ error: { code: "NOT_FOUND" } });

    // Given: a fresh user with no variables.
    const missingFx = await track(
      store.set(seedVariables$, [], context.signal),
    );
    mocks.clerk.session(missingFx.userId, missingFx.orgId);

    // When + Then: 404 — "NONEXISTENT" not found.
    const missing = await accept(
      c.delete({
        params: { name: "NONEXISTENT" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: {
        message: 'Variable "NONEXISTENT" not found',
        code: "NOT_FOUND",
      },
    });
  });
});

describe("BDD DELETE /api/zero/variables/:name — 404 isolation chain", () => {
  it("gwt-wt-wt: 404 on cross-user (victim intact) → 404 on cross-org (victim intact)", async () => {
    const c = client();

    // Given: a fresh user; another user in the same org owns
    // OTHER_USER_VAR.
    const crossUserFx = await track(
      store.set(seedVariables$, [], context.signal),
    );
    await store.set(seedOtherVariable$, crossUserFx, context.signal);
    mocks.clerk.session(crossUserFx.userId, crossUserFx.orgId);

    // When + Then: 404 — the user cannot delete the other
    // user's variable.
    const crossUser = await accept(
      c.delete({
        params: { name: "OTHER_USER_VAR" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUser.body).toMatchObject({ error: { code: "NOT_FOUND" } });

    // Then: the victim row is still present (not silently
    // deleted).
    const writeDb = store.set(writeDb$);
    const victim = await writeDb
      .select({ id: variables.id })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, crossUserFx.orgId),
          eq(variables.name, "OTHER_USER_VAR"),
        ),
      );
    expect(victim).toHaveLength(1);

    // Given: an org A with a variable; authenticate as a
    // different user in a different org.
    const orgAFx = await track(
      store.set(
        seedVariables$,
        [{ name: "ORG_A_VAR", value: "value-a" }],
        context.signal,
      ),
    );
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    // When + Then: 404 — cross-org access is not allowed.
    const crossOrg = await accept(
      c.delete({
        params: { name: "ORG_A_VAR" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossOrg.body).toMatchObject({ error: { code: "NOT_FOUND" } });

    // Then: the org A row is still present.
    const orgARow = await writeDb
      .select({ id: variables.id, orgId: variables.orgId })
      .from(variables)
      .where(
        and(eq(variables.orgId, orgAFx.orgId), eq(variables.name, "ORG_A_VAR")),
      );
    expect(orgARow).toHaveLength(1);
    expect(orgARow[0]?.orgId).toBe(orgAFx.orgId);
  });
});
