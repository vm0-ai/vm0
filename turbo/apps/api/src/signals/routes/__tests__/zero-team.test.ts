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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/team", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroTeamContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 403 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [] }, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context })(zeroTeamContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "No active organization. Please select an org.",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns an empty list when the active org has no composes", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [] }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroTeamContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual([]);
  });

  it("returns the composes belonging to the active org", async () => {
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroTeamContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual([
      {
        id: fixture.composeIds[0],
        ownerId: fixture.userId,
        displayName: "team-agent",
        description: "team description",
        sound: "ding",
        avatarUrl: "https://example.com/avatar.png",
        headVersionId: "version-1",
        updatedAt: expect.any(String),
      },
    ]);
  });

  it("does not include composes from other orgs", async () => {
    const myFixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [{ displayName: "my-agent" }],
        },
        context.signal,
      ),
    );
    const otherFixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [{ displayName: "other-agent" }],
        },
        context.signal,
      ),
    );

    mocks.clerk.session(myFixture.userId, myFixture.orgId);

    const client = setupApp({ context })(zeroTeamContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toHaveLength(1);
    const [only] = response.body;
    expect(only?.id).toBe(myFixture.composeIds[0]);
    expect(only?.displayName).toBe("my-agent");
    expect(
      response.body.map((c) => {
        return c.id;
      }),
    ).not.toContain(otherFixture.composeIds[0]);
  });
});
