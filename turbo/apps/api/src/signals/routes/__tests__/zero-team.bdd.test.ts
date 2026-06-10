import { zeroTeamContract } from "@vm0/api-contracts/contracts/zero-team";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";

// BDD migration of the legacy `zero-team.test.ts`. The 8 legacy
// `it()`s collapse into 3 BDD `it()`s: (1) auth boundary chain
// (401 unauth → 403 no-org), (2) 200 list chain (empty org → org
// with a single compose → org with custom skills → cross-org
// isolation, other-org's composes not visible), (3) 200 filter
// chain (compose without zero-agent metadata excluded → public
// + owned-private composes visible, other-owned private
// composes excluded).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroTeamContract);
}

const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
  return store.set(deleteTeamCompose$, fixture, context.signal);
});

describe("BDD GET /api/zero/team — auth boundary", () => {
  it("gwt-wt-wt: 401 unauth → 403 no-org", async () => {
    const c = client();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(c.list({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with a user but no org.
    const noOrgFx = await track(
      store.set(seedTeamCompose$, { composes: [] }, context.signal),
    );
    mocks.clerk.session(noOrgFx.userId, null);

    // When + Then: 403 — no active org.
    const noOrg = await accept(c.list({ headers: authHeaders() }), [403]);
    expect(noOrg.body).toStrictEqual({
      error: {
        message: "No active organization. Please select an org.",
        code: "FORBIDDEN",
      },
    });
  });
});

describe("BDD GET /api/zero/team — 200 list chain", () => {
  it("gwt-wt-wt: empty org → single compose (all fields) → custom skills → cross-org isolation", async () => {
    const c = client();

    // Given: an org with no composes.
    const emptyFx = await track(
      store.set(seedTeamCompose$, { composes: [] }, context.signal),
    );
    mocks.clerk.session(emptyFx.userId, emptyFx.orgId);

    // When + Then: empty list.
    const empty = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(empty.body).toStrictEqual([]);

    // Given: an org with a single compose (all optional fields
    // populated).
    const fullFx = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [
            {
              displayName: "team-agent",
              description: "team description",
              sound: "ding",
              avatarUrl: "https://example.com/avatar.png",
              headVersionId: "version-1",
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fullFx.userId, fullFx.orgId);

    // When + Then: the compose is returned with all fields.
    const full = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(full.body).toStrictEqual([
      {
        id: fullFx.composeIds[0],
        ownerId: fullFx.userId,
        displayName: "team-agent",
        description: "team description",
        sound: "ding",
        avatarUrl: "https://example.com/avatar.png",
        customSkills: [],
        visibility: "public",
        headVersionId: "version-1",
        updatedAt: expect.any(String),
      },
    ]);

    // Given: an org with a compose that has custom skills.
    const skillsFx = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [
            {
              displayName: "research-agent",
              customSkills: ["research-kit", "draft-helper"],
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(skillsFx.userId, skillsFx.orgId);

    // When + Then: the custom skills are returned.
    const skills = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(skills.body[0]?.customSkills).toStrictEqual([
      "research-kit",
      "draft-helper",
    ]);

    // Given: my org has a compose; another org has a different
    // compose; authenticate as me.
    const myFx = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [{ displayName: "my-agent" }],
        },
        context.signal,
      ),
    );
    const otherFx = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [{ displayName: "other-agent" }],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(myFx.userId, myFx.orgId);

    // When + Then: only my compose is listed; the other org's
    // compose is excluded.
    const isolated = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(isolated.body).toHaveLength(1);
    const [only] = isolated.body;
    expect(only?.id).toBe(myFx.composeIds[0]);
    expect(only?.displayName).toBe("my-agent");
    expect(
      isolated.body.map((agent) => {
        return agent.id;
      }),
    ).not.toContain(otherFx.composeIds[0]);
  });
});

describe("BDD GET /api/zero/team — 200 filter chain", () => {
  it("gwt-wt-wt: composes without zero-agent metadata are excluded → public + owned-private composes are visible, other-owned private composes are excluded", async () => {
    const c = client();

    // Given: an org with two composes; one has zero-agent
    // metadata, the other does not.
    const metaFx = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [{ displayName: "listed-agent" }, { withZeroAgent: false }],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(metaFx.userId, metaFx.orgId);

    // When + Then: only the compose with zero-agent metadata
    // is listed.
    const metadata = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(metadata.body).toHaveLength(1);
    expect(metadata.body[0]?.id).toBe(metaFx.composeIds[0]);
    expect(
      metadata.body.map((agent) => {
        return agent.id;
      }),
    ).not.toContain(metaFx.composeIds[1]);

    // Given: an org with three composes — public, owned-private,
    // and other-owned-private.
    const otherOwnerId = "user_other_private_agent_owner";
    const visFx = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [
            { displayName: "public-agent" },
            {
              displayName: "owned-private-agent",
              visibility: "private",
            },
            {
              displayName: "other-private-agent",
              ownerId: otherOwnerId,
              visibility: "private",
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(visFx.userId, visFx.orgId);

    // When + Then: public + owned-private are visible;
    // other-owned-private is excluded.
    const visible = await accept(c.list({ headers: authHeaders() }), [200]);
    const displayNames = visible.body.map((agent) => {
      return agent.displayName;
    });
    expect(displayNames).toHaveLength(2);
    expect(displayNames).toContain("public-agent");
    expect(displayNames).toContain("owned-private-agent");
    const ids = visible.body.map((agent) => {
      return agent.id;
    });
    expect(ids).not.toContain(visFx.composeIds[2]);
  });
});
