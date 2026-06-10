import { randomUUID } from "node:crypto";

import { zeroAgentsMainContract } from "@vm0/api-contracts/contracts/zero-agents";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteSkillsForFixture$,
  seedAgentForInstructions$,
  seedSkillsFixture$,
  type SkillsFixture,
} from "./helpers/zero-skills";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-agents-list.test.ts`. The Given
// uses `seedSkillsFixture$` and `seedAgentForInstructions$` (recorded
// under "Open Helper Gaps" in `api.bdd.md` — direct agent creates are
// also exercised through the POST /api/zero/agents contract path in
// the chain). The 6 legacy `it()`s collapse into 2 BDD `it()`s.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

describe("BDD GET /api/zero/agents — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = apiClient();

    // When + Then: no auth header → 401.
    const unauth = await accept(c.list({ headers: {} }), [401]);
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with a user but no org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(c.list({ headers: authHeaders() }), [401]);
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

const track = createFixtureTracker<SkillsFixture>((fixture) => {
  return store.set(deleteSkillsForFixture$, fixture, context.signal);
});

describe("BDD GET /api/zero/agents — list chain", () => {
  it("gwt-wt-wt: empty → seeded → POSTed → cross-org isolated", async () => {
    const c = apiClient();

    // Given: a fresh user/org with no agents.
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: the list is empty.
    const empty = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(empty.body).toStrictEqual([]);

    // Given: a directly-seeded agent (recorded as a helper gap).
    const { agentId: seededAgentId } = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Listed Agent",
        description: "desc",
        sound: "friendly",
      },
      context.signal,
    );

    // When + Then: the list contains the seeded agent.
    const seeded = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(seeded.body).toHaveLength(1);
    expect(seeded.body[0]?.agentId).toBe(seededAgentId);
    expect(seeded.body[0]?.ownerId).toBe(fixture.userId);
    expect(seeded.body[0]?.displayName).toBe("Listed Agent");
    expect(seeded.body[0]?.description).toBe("desc");
    expect(seeded.body[0]?.sound).toBe("friendly");

    // Given: a fresh fixture; the caller creates an agent through the
    // public POST /api/zero/agents contract (real API call, not a
    // helper). S3 mocks are reset so the POST can call out cleanly.
    const postFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(postFixture.userId, postFixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    const created = await accept(
      c.create({
        headers: authHeaders(),
        body: {
          displayName: "Listed Agent",
          description: "desc",
          sound: "friendly",
        },
      }),
      [201],
    );

    // When + Then: the list now includes the POSTed agent.
    const posted = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(posted.body).toHaveLength(1);
    expect(posted.body[0]?.agentId).toBe(created.body.agentId);
    expect(posted.body[0]?.displayName).toBe("Listed Agent");
    expect(posted.body[0]?.description).toBe("desc");
    expect(posted.body[0]?.sound).toBe("friendly");

    // Given: a different org owns an agent; the caller is on their
    // own org.
    const otherFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    await store.set(
      seedAgentForInstructions$,
      {
        orgId: otherFixture.orgId,
        userId: otherFixture.userId,
        displayName: "Foreign Agent",
      },
      context.signal,
    );
    mocks.clerk.session(postFixture.userId, postFixture.orgId);

    // When + Then: the caller's list contains only their own agent.
    const isolated = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(isolated.body).toHaveLength(1);
    expect(isolated.body[0]?.displayName).toBe("Listed Agent");
  });
});
