import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { zeroSecretsByNameContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { secrets } from "@vm0/db/schema/secret";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUserData$,
  seedOtherSecret$,
  seedSecrets$,
  type UserDataFixture,
} from "./helpers/zero-user-data";

// BDD migration of the legacy `zero-secrets-delete.test.ts`.
// The 7 legacy `it()`s collapse into 3 BDD `it()`s: (1) auth
// boundary chain (401 unauth → 401 no-org), (2) 204 success
// chain (204 deletes the secret and removes the row → 404 on
// missing → 404 on cross-user isolation with victim intact),
// (3) 404 isolation chain (404 on cross-org with victim intact
// → 404 on non-user-type with victim intact).
//
// Service-Level Exception: secrets are seeded directly via
// `writeDb$` (via `seedSecrets$` and `seedOtherSecret$`)
// because no public route creates a `secrets` row. Post-delete
// verification uses direct DB reads against the `secrets`
// table since there is no follow-up GET endpoint for this
// resource.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroSecretsByNameContract);
}

const track = createFixtureTracker<UserDataFixture>((fixture) => {
  return store.set(deleteUserData$, fixture, context.signal);
});

describe("BDD DELETE /api/zero/secrets/:name — auth boundary", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org", async () => {
    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      client().delete({ params: { name: "ANY_KEY" }, headers: {} }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session that resolves to a user without an org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(
      client().delete({
        params: { name: "ANY_KEY" },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });
});

describe("BDD DELETE /api/zero/secrets/:name — 204 + 404 chain", () => {
  it("gwt-wt-wt: 204 deletes the secret and removes the row → 404 on missing → 404 on cross-user (victim intact)", async () => {
    // Given: a user with a DELETE_ME secret.
    const fixture = await track(
      store.set(
        seedSecrets$,
        [{ name: "DELETE_ME", type: "user" }],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When: delete the secret.
    const deleted = await client().delete({
      params: { name: "DELETE_ME" },
      headers: authHeaders(),
    });

    // Then: 204 + the row is gone.
    expect(deleted.status).toBe(204);
    const writeDb = store.set(writeDb$);
    const remaining = await writeDb
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
          eq(secrets.name, "DELETE_ME"),
        ),
      );
    expect(remaining).toStrictEqual([]);

    // Given: a fresh user with no secrets.
    const missingFx = await track(store.set(seedSecrets$, [], context.signal));
    mocks.clerk.session(missingFx.userId, missingFx.orgId);

    // When + Then: 404 — "NONEXISTENT" not found.
    const missing = await accept(
      client().delete({
        params: { name: "NONEXISTENT" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: {
        message: 'Secret "NONEXISTENT" not found',
        code: "NOT_FOUND",
      },
    });

    // Given: a fresh user; another user in the same org
    // has the secret "OTHER_USER_SECRET".
    const crossFx = await track(store.set(seedSecrets$, [], context.signal));
    await store.set(seedOtherSecret$, crossFx, context.signal);
    mocks.clerk.session(crossFx.userId, crossFx.orgId);

    // When + Then: 404 — the victim user cannot delete the
    // other user's secret.
    const crossUser = await accept(
      client().delete({
        params: { name: "OTHER_USER_SECRET" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUser.body).toMatchObject({ error: { code: "NOT_FOUND" } });

    // Then: the victim row is still present (not silently
    // deleted).
    const victim = await writeDb
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, crossFx.orgId),
          eq(secrets.name, "OTHER_USER_SECRET"),
        ),
      );
    expect(victim).toHaveLength(1);
  });
});

describe("BDD DELETE /api/zero/secrets/:name — 404 isolation chain", () => {
  it("gwt-wt-wt: 404 on cross-org (victim intact) → 404 on non-user-type secret (connector type preserved)", async () => {
    // Given: an org A with a secret; authenticate as a
    // different user in a different org.
    const orgAFixture = await track(
      store.set(
        seedSecrets$,
        [{ name: "ORG_A_SECRET", type: "user" }],
        context.signal,
      ),
    );
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    // When + Then: 404 — cross-org access is not allowed.
    const crossOrg = await accept(
      client().delete({
        params: { name: "ORG_A_SECRET" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossOrg.body).toMatchObject({ error: { code: "NOT_FOUND" } });

    // Then: the org A secret row is still present.
    const writeDb = store.set(writeDb$);
    const orgARow = await writeDb
      .select({ id: secrets.id, orgId: secrets.orgId })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgAFixture.orgId),
          eq(secrets.name, "ORG_A_SECRET"),
        ),
      );
    expect(orgARow).toHaveLength(1);
    expect(orgARow[0]?.orgId).toBe(orgAFixture.orgId);

    // Given: a user with a connector-type secret
    // (CONNECTOR_SECRET).
    const connectorFx = await track(
      store.set(
        seedSecrets$,
        [{ name: "CONNECTOR_SECRET", type: "connector" }],
        context.signal,
      ),
    );
    mocks.clerk.session(connectorFx.userId, connectorFx.orgId);

    // When + Then: 404 — the user-secret delete endpoint
    // does not apply to connector-type secrets.
    const connector = await accept(
      client().delete({
        params: { name: "CONNECTOR_SECRET" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(connector.body).toMatchObject({ error: { code: "NOT_FOUND" } });

    // Then: the connector secret row is preserved.
    const connectorRow = await writeDb
      .select({ id: secrets.id, type: secrets.type })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, connectorFx.orgId),
          eq(secrets.userId, connectorFx.userId),
          eq(secrets.name, "CONNECTOR_SECRET"),
        ),
      );
    expect(connectorRow).toHaveLength(1);
    expect(connectorRow[0]?.type).toBe("connector");
  });
});
