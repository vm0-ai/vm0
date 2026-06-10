import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { zeroCustomConnectorByIdContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteCustomConnectorOrg$,
  seedCustomConnectorOrg$,
  type CustomConnectorFixture,
} from "./helpers/zero-custom-connectors";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy
// `zero-custom-connectors-patch.test.ts`. The 7 legacy `it()`s
// collapse into 3 BDD `it()`s: (1) auth + 403 chain (401
// unauth → 401 no-org → 403 non-admin), (2) 200 success
// chain (admin renames the connector + read-after-write
// confirms the new name → 404 unknown id → 404 cross-org
// with victim intact), (3) 400 validation chain (400 on
// empty displayName + original preserved).
//
// Service-Level Exception: custom connector rows are seeded
// directly via `writeDb$` because no public route creates one
// (they are provisioned by the admin onboarding flow, not the
// public API). Post-patch verification uses direct DB reads
// against `org_custom_connectors` because no follow-up GET
// endpoint for a single custom connector is available.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroCustomConnectorByIdContract);
}

async function getDisplayName(
  connectorId: string,
): Promise<string | undefined> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select({ displayName: orgCustomConnectors.displayName })
    .from(orgCustomConnectors)
    .where(eq(orgCustomConnectors.id, connectorId));
  return row?.displayName;
}

const track = createFixtureTracker<CustomConnectorFixture>((fixture) => {
  return store.set(deleteCustomConnectorOrg$, fixture, context.signal);
});

describe("BDD PATCH /api/zero/custom-connectors/:id — auth + 403 chain", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org → 403 non-admin", async () => {
    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      client().patch({
        params: { id: randomUUID() },
        headers: {},
        body: { displayName: "Renamed" },
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session that resolves to a user without an org.
    const noOrgFx = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(noOrgFx.userId, null);

    // When + Then: still 401.
    const noOrg = await accept(
      client().patch({
        params: { id: noOrgFx.connectorId },
        headers: authHeaders(),
        body: { displayName: "Renamed" },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a non-admin org member.
    const fixture = await track(
      store.set(
        seedCustomConnectorOrg$,
        { displayName: "Original" },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    // When + Then: 403 — non-admin cannot rename custom
    // connectors.
    const nonAdmin = await accept(
      client().patch({
        params: { id: fixture.connectorId },
        headers: authHeaders(),
        body: { displayName: "Hacked" },
      }),
      [403],
    );
    expect(nonAdmin.body).toStrictEqual({
      error: {
        message: "Only org admins can rename custom connectors",
        code: "FORBIDDEN",
      },
    });
    await expect(getDisplayName(fixture.connectorId)).resolves.toBe("Original");
  });
});

describe("BDD PATCH /api/zero/custom-connectors/:id — 200 success + 404 chain", () => {
  it("gwt-wt-wt: 200 admin renames the connector + read-after-write confirms the new name → 404 unknown id → 404 cross-org (victim intact)", async () => {
    // Given: a connector owned by the test org.
    const fixture = await track(
      store.set(
        seedCustomConnectorOrg$,
        { displayName: "Original", slug: "patch-happy" },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    // When: rename the connector.
    const renamed = await accept(
      client().patch({
        params: { id: fixture.connectorId },
        headers: authHeaders(),
        body: { displayName: "Renamed" },
      }),
      [200],
    );

    // Then: 200 with the new displayName + read-after-write
    // confirms the new name on the row.
    expect(renamed.body.id).toBe(fixture.connectorId);
    expect(renamed.body.displayName).toBe("Renamed");
    expect(renamed.body.slug).toBe("patch-happy");
    expect(renamed.body.hasSecret).toBeFalsy();
    await expect(getDisplayName(fixture.connectorId)).resolves.toBe("Renamed");

    // Given: a session for an admin in the same org + an
    // unknown connector id.
    const unknownFx = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(unknownFx.userId, unknownFx.orgId, "org:admin");
    const unknownId = randomUUID();

    // When + Then: 404 — unknown id.
    const unknown = await accept(
      client().patch({
        params: { id: unknownId },
        headers: authHeaders(),
        body: { displayName: "Renamed" },
      }),
      [404],
    );
    expect(unknown.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "Custom connector not found" },
    });

    // Given: a connector owned by a different org + an
    // admin session in the test org.
    const otherFixture = await track(
      store.set(
        seedCustomConnectorOrg$,
        { displayName: "OtherOrg" },
        context.signal,
      ),
    );
    const myFixture = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(myFixture.userId, myFixture.orgId, "org:admin");

    // When + Then: 404 — cross-org access returns a
    // non-existence-leaking 404.
    const crossOrg = await accept(
      client().patch({
        params: { id: otherFixture.connectorId },
        headers: authHeaders(),
        body: { displayName: "Hijacked" },
      }),
      [404],
    );
    expect(crossOrg.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "Custom connector not found" },
    });

    // Then: the victim connector's displayName is preserved.
    await expect(getDisplayName(otherFixture.connectorId)).resolves.toBe(
      "OtherOrg",
    );
  });
});

describe("BDD PATCH /api/zero/custom-connectors/:id — 400 validation chain", () => {
  it("gwt-wt-wt: 400 on empty displayName with the original preserved", async () => {
    // Given: a connector with displayName "Original".
    const fixture = await track(
      store.set(
        seedCustomConnectorOrg$,
        { displayName: "Original" },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    // When + Then: 400 on empty displayName.
    const empty = await accept(
      client().patch({
        params: { id: fixture.connectorId },
        headers: authHeaders(),
        body: { displayName: "" },
      }),
      [400],
    );
    expect(empty.body).toMatchObject({ error: { code: "BAD_REQUEST" } });

    // Then: the original displayName is preserved.
    await expect(getDisplayName(fixture.connectorId)).resolves.toBe("Original");
  });
});
