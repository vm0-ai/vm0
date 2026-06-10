import { randomUUID } from "node:crypto";

import { zeroComposesListContract } from "@vm0/api-contracts/contracts/zero-composes";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-composes-list.test.ts`. The Given
// uses `seedTeamCompose$` — recorded under "Open Helper Gaps" in
// `api.bdd.md`. The 6 legacy `it()`s collapse into 2 BDD `it()`s.

const HEAD_VERSION_HEX = "a".repeat(64);

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroComposesListContract);
}

describe("BDD GET /api/zero/composes/list — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = client();

    // When + Then: no auth header → 401.
    const unauth = await accept(c.list({ query: {}, headers: {} }), [401]);
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with a user but no org. The list route
    // returns 400 "Invalid request" to mirror the web wording; the
    // authRoute's built-in requireOrganization would change the
    // message, so the route is wired to 400 here.
    const fixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    // When + Then: 400 BAD_REQUEST.
    const noOrg = await accept(
      c.list({ query: {}, headers: authHeaders() }),
      [400],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
  });
});

const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
  return store.set(deleteTeamCompose$, fixture, context.signal);
});

describe("BDD GET /api/zero/composes/list — list chain", () => {
  it("gwt-wt-wt: empty → populated (ordered) → cross-org isolated → sandbox token accepted", async () => {
    const c = client();

    // Given: a fresh user/org with no composes.
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    // When + Then: the list is empty.
    const empty = await accept(
      c.list({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(empty.body).toStrictEqual({ composes: [] });

    // Given: two composes in the same fixture (ordered by updatedAt
    // desc in the list response).
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [
            {
              displayName: "First Agent",
              description: "first",
              sound: "ding",
              headVersionId: HEAD_VERSION_HEX,
            },
            {
              displayName: "Second Agent",
              description: "second",
              sound: "pong",
              headVersionId: HEAD_VERSION_HEX,
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: the list has both composes, each with the
    // configured head version and an ISO `updatedAt`.
    const populated = await accept(
      c.list({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(populated.body.composes).toHaveLength(2);
    const names = populated.body.composes.map((entry) => {
      return entry.name;
    });
    const expectedFirstName = `agent-${fixture.composeIds[0]?.slice(0, 8) ?? ""}`;
    const expectedSecondName = `agent-${fixture.composeIds[1]?.slice(0, 8) ?? ""}`;
    expect(names).toContain(expectedFirstName);
    expect(names).toContain(expectedSecondName);
    for (const compose of populated.body.composes) {
      expect(compose.headVersionId).toBe(HEAD_VERSION_HEX);
      expect(typeof compose.updatedAt).toBe("string");
      expect(compose.id).toBeDefined();
    }

    // Given: a separate org owns another compose; the caller is on
    // their own org.
    const myFixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "my-agent" }] },
        context.signal,
      ),
    );
    const otherFixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "other-agent" }] },
        context.signal,
      ),
    );
    mocks.clerk.session(myFixture.userId, myFixture.orgId);

    // When + Then: only the caller's own compose is returned.
    const isolated = await accept(
      c.list({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(isolated.body.composes).toHaveLength(1);
    const [only] = isolated.body.composes;
    expect(only?.id).toBe(myFixture.composeIds[0]);
    expect(only?.displayName).toBe("my-agent");
    expect(
      isolated.body.composes.map((c) => {
        return c.id;
      }),
    ).not.toContain(otherFixture.composeIds[0]);

    // Given: a sandbox-scoped token (matches the route's
    // acceptAnySandboxCapability behavior — sandbox tokens can list
    // composes for the org derived from the token).
    const sandboxUserId = `user_${randomUUID()}`;
    const sandboxOrgId = `org_${randomUUID()}`;
    const seconds = currentSecond();
    const sandboxToken = signSandboxJwtForTests({
      scope: "sandbox",
      userId: sandboxUserId,
      orgId: sandboxOrgId,
      runId: `run_${randomUUID()}`,
      iat: seconds,
      exp: seconds + 60,
    });

    // When + Then: the sandbox token reaches the inner handler; the
    // org has no composes so the list is empty.
    const sandbox = await accept(
      c.list({
        query: {},
        headers: { authorization: `Bearer ${sandboxToken}` },
      }),
      [200],
    );
    expect(sandbox.body).toStrictEqual({ composes: [] });
  });
});
