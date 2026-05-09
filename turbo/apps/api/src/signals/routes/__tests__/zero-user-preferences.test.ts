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
const track = createFixtureTracker<UserDataFixture>((fixture) => {
  return store.set(deleteUserData$, fixture, context.signal);
});

function apiClient() {
  return setupApp({ context })(zeroUserPreferencesContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function createTrackedFixture(): Promise<UserDataFixture> {
  return track(
    Promise.resolve({
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
    }),
  );
}

describe("GET /api/zero/user-preferences", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const client = apiClient();

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

    const client = apiClient();

    const response = await accept(
      client.get({
        headers: authHeaders(),
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

    const client = apiClient();

    const response = await accept(
      client.get({
        headers: authHeaders(),
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

    const client = apiClient();

    const response = await accept(
      client.get({
        headers: authHeaders(),
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

describe("POST /api/zero/user-preferences", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const client = apiClient();

    const response = await accept(
      client.update({
        headers: {},
        body: { timezone: "America/New_York" },
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

  it("returns 401 when the authenticated session has no organization", async () => {
    const fixture = await track(
      store.set(seedUserPreferences$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    const client = apiClient();

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: { timezone: "America/New_York" },
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

  it("returns 400 when timezone is invalid", async () => {
    const fixture = await track(
      store.set(seedUserPreferences$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = apiClient();

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: { timezone: "Invalid/Timezone" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid request",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 400 when no preference update is provided", async () => {
    const fixture = await track(
      store.set(seedUserPreferences$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = apiClient();

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: {},
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("creates preferences with all supported fields", async () => {
    const fixture = await createTrackedFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = apiClient();

    const updateResponse = await accept(
      client.update({
        headers: authHeaders(),
        body: {
          timezone: "Europe/London",
          pinnedAgentIds: ["agent-a", "agent-b"],
          sendMode: "cmd-enter",
          captureNetworkBodiesRemaining: 4,
        },
      }),
      [200],
    );

    const expected = {
      timezone: "Europe/London",
      pinnedAgentIds: ["agent-a", "agent-b"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 4,
    };
    expect(updateResponse.body).toStrictEqual(expected);

    const getResponse = await accept(
      client.get({
        headers: authHeaders(),
      }),
      [200],
    );
    expect(getResponse.body).toStrictEqual(expected);
  });

  it("updates timezone without changing existing preference fields", async () => {
    const fixture = await track(
      store.set(
        seedUserPreferences$,
        {
          timezone: "Asia/Tokyo",
          pinnedAgentIds: ["agent-old"],
          sendMode: "cmd-enter",
          captureNetworkBodiesRemaining: 2,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = apiClient();

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: { timezone: "America/Los_Angeles" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      timezone: "America/Los_Angeles",
      pinnedAgentIds: ["agent-old"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 2,
    });
  });

  it("updates pinnedAgentIds without changing existing preference fields", async () => {
    const fixture = await track(
      store.set(
        seedUserPreferences$,
        {
          timezone: "Asia/Tokyo",
          pinnedAgentIds: ["agent-old"],
          sendMode: "cmd-enter",
          captureNetworkBodiesRemaining: 2,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = apiClient();

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: { pinnedAgentIds: ["agent-new", "agent-extra"] },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      timezone: "Asia/Tokyo",
      pinnedAgentIds: ["agent-new", "agent-extra"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 2,
    });
  });

  it("updates sendMode without changing existing preference fields", async () => {
    const fixture = await track(
      store.set(
        seedUserPreferences$,
        {
          timezone: "Asia/Tokyo",
          pinnedAgentIds: ["agent-old"],
          sendMode: "enter",
          captureNetworkBodiesRemaining: 2,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = apiClient();

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: { sendMode: "cmd-enter" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      timezone: "Asia/Tokyo",
      pinnedAgentIds: ["agent-old"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 2,
    });
  });

  it("updates captureNetworkBodiesRemaining without changing existing preference fields", async () => {
    const fixture = await track(
      store.set(
        seedUserPreferences$,
        {
          timezone: "Asia/Tokyo",
          pinnedAgentIds: ["agent-old"],
          sendMode: "cmd-enter",
          captureNetworkBodiesRemaining: 2,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = apiClient();

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: { captureNetworkBodiesRemaining: 7 },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      timezone: "Asia/Tokyo",
      pinnedAgentIds: ["agent-old"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 7,
    });
  });
});
