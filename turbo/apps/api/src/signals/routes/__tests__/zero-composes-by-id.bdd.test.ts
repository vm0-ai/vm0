import { randomUUID } from "node:crypto";

import { zeroComposesByIdContract } from "@vm0/api-contracts/contracts/zero-composes";
import { createStore } from "ccstate";

import { createApp } from "../../../app-factory";
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

// BDD migration of the legacy `zero-composes-by-id.test.ts`. The Given
// uses `seedTeamCompose$` (a transitional DB-seed helper recorded under
// "Open Helper Gaps" in `api.bdd.md` — no public route creates a compose
// without going through the POST flow). The 6 legacy `it()`s collapse
// into 2 BDD `it()`s (auth boundary + a gwt-wt-wt chain that exercises
// the malformed-id boundary, the 404 missing/cross-org paths, and the
// 200 success path in one shared session).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroComposesByIdContract);
}

describe("BDD GET /api/zero/composes/:id — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = client();

    // When + Then: no auth header → 401.
    const unauth = await accept(
      c.getById({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a session with a user but no org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(
      c.getById({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body.error.code).toBe("UNAUTHORIZED");
  });
});

const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
  return store.set(deleteTeamCompose$, fixture, context.signal);
});

describe("BDD GET /api/zero/composes/:id — read chain", () => {
  it("gwt-wt-wt: malformed id → 404 missing → 200 own → 404 cross-org", async () => {
    // Given: a Clerk session for a fresh caller.
    const callerUserId = `user_${randomUUID()}`;
    const callerOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(callerUserId, callerOrgId);
    const c = client();

    // When + Then: a malformed (non-UUID) id returns 400 from the
    // contract-level path-param validation. The contract will not let
    // us send a non-UUID through ts-rest, so we hit the route directly
    // to exercise the boundary check.
    const app = createApp({ signal: context.signal });
    const malformed = await app.request(
      "/api/zero/composes/91fc0bd84bba673393d9adfc1a0f4dec",
      {
        method: "GET",
        headers: authHeaders(),
      },
    );
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as {
      error: { code: string; message: string };
    };
    expect(malformedBody.error.code).toBe("BAD_REQUEST");
    expect(malformedBody.error.message).toContain("valid UUID");

    // When + Then: a valid but non-existent id returns 404.
    const missing = await accept(
      c.getById({ params: { id: randomUUID() }, headers: authHeaders() }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });

    // Given: a compose owned by a fresh fixture; the caller session
    // is updated to that fixture so the GET sees the compose.
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const composeId = fixture.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: GET returns the compose with the canonical
    // `agent-${id.slice(0,8)}` name.
    const found = await accept(
      c.getById({ params: { id: composeId }, headers: authHeaders() }),
      [200],
    );
    expect(found.body.id).toBe(composeId);
    expect(found.body.name).toBe(`agent-${composeId.slice(0, 8)}`);

    // Given: a compose owned by a different org/user.
    const otherFixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const otherComposeId = otherFixture.composeIds[0];
    if (!otherComposeId) {
      throw new Error("Expected seeded compose");
    }

    // When + Then: a different caller gets 404 (no existence leak).
    mocks.clerk.session(callerUserId, callerOrgId);
    const blocked = await accept(
      c.getById({ params: { id: otherComposeId }, headers: authHeaders() }),
      [404],
    );
    expect(blocked.body).toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });
  });
});
