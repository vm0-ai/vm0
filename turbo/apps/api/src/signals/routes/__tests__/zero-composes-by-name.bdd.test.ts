import { zeroComposesMainContract } from "@vm0/api-contracts/contracts/zero-composes";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-composes-by-name.test.ts`. The
// Given uses `seedTeamCompose$` — recorded under "Open Helper Gaps" in
// `api.bdd.md`. The 5 legacy `it()`s collapse into 2 BDD `it()`s.

const HEAD_VERSION_HEX = "a".repeat(64);

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroComposesMainContract);
}

describe("BDD GET /api/zero/composes (getByName) — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = client();

    // When + Then: no auth header → 401.
    const unauth = await accept(
      c.getByName({ query: { name: "any-agent" }, headers: {} }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with a user but no org.
    const fixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    // When + Then: still 401.
    const noOrg = await accept(
      c.getByName({
        query: { name: "any-agent" },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
  return store.set(deleteTeamCompose$, fixture, context.signal);
});

describe("BDD GET /api/zero/composes (getByName) — read chain", () => {
  it("gwt-wt-wt: 200 found → 404 missing → 404 cross-org", async () => {
    const c = client();

    // Given: a fresh caller session with a seeded compose and a
    // known head version.
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ headVersionId: HEAD_VERSION_HEX }] },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const composeId = fixture.composeIds[0]!;
    const expectedName = `agent-${composeId.slice(0, 8)}`;

    // When + Then: GET by name returns the compose with the
    // configured head version and ISO timestamps.
    const found = await accept(
      c.getByName({ query: { name: expectedName }, headers: authHeaders() }),
      [200],
    );
    expect(found.body).toStrictEqual({
      id: composeId,
      name: expectedName,
      headVersionId: HEAD_VERSION_HEX,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      content: null,
    });

    // When + Then: an unknown name returns 404.
    const missing = await accept(
      c.getByName({
        query: { name: "nonexistent-agent" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: {
        message: "Agent compose not found: nonexistent-agent",
        code: "NOT_FOUND",
      },
    });

    // Given: a different org owns a compose with a name that the
    // caller does NOT have. The caller is on their own org.
    const otherFixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const sharedComposeId = otherFixture.composeIds[0]!;
    const sharedName = `agent-${sharedComposeId.slice(0, 8)}`;
    const myFixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(myFixture.userId, myFixture.orgId);

    // When + Then: the caller's GET still 404s — names are scoped to
    // the active org.
    const crossOrg = await accept(
      c.getByName({ query: { name: sharedName }, headers: authHeaders() }),
      [404],
    );
    expect(crossOrg.body).toStrictEqual({
      error: {
        message: `Agent compose not found: ${sharedName}`,
        code: "NOT_FOUND",
      },
    });
  });
});
