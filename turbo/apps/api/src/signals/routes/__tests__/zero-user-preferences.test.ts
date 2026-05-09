import { randomUUID } from "node:crypto";

import { zeroUserPreferencesContract } from "@vm0/api-contracts/contracts/zero-user-preferences";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUserData$,
  seedUserPreferences$,
  type UserDataFixture,
} from "./helpers/zero-user-data";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/user-preferences", () => {
  const track = createFixtureTracker<UserDataFixture>((fixture) => {
    return store.set(deleteUserData$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroUserPreferencesContract);

    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const fixture = await track(
      store.set(seedUserPreferences$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context })(zeroUserPreferencesContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns the persisted preferences for the current org member", async () => {
    const fixture = await track(
      store.set(
        seedUserPreferences$,
        {
          timezone: "America/Los_Angeles",
          pinnedAgentIds: ["agent_b", "agent_a"],
          sendMode: "cmd-enter",
          captureNetworkBodiesRemaining: 3,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroUserPreferencesContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      timezone: "America/Los_Angeles",
      pinnedAgentIds: ["agent_b", "agent_a"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 3,
    });
  });

  it("returns defaults when the org member metadata row does not exist", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroUserPreferencesContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
      captureNetworkBodiesRemaining: 0,
    });
  });
});
