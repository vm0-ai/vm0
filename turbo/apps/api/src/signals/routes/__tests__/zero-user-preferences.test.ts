import { randomUUID } from "node:crypto";

import {
  zeroUserPreferencesContract,
  type UpdateUserPreferencesRequest,
  type UserPreferencesResponse,
} from "@vm0/api-contracts/contracts/zero-user-preferences";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface UserPreferencesRouteFixture {
  readonly orgId: string;
  readonly userId: string;
}

function apiClient() {
  return setupApp({ context })(zeroUserPreferencesContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function createFixture(): UserPreferencesRouteFixture {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

async function updatePreferencesThroughApi(
  fixture: UserPreferencesRouteFixture,
  body: UpdateUserPreferencesRequest,
): Promise<UserPreferencesResponse> {
  mocks.clerk.session(fixture.userId, fixture.orgId);

  const response = await accept(
    apiClient().update({
      headers: authHeaders(),
      body,
    }),
    [200],
  );

  return response.body;
}

async function getPreferencesThroughApi(
  fixture: UserPreferencesRouteFixture,
): Promise<UserPreferencesResponse> {
  mocks.clerk.session(fixture.userId, fixture.orgId);

  const response = await accept(
    apiClient().get({
      headers: authHeaders(),
    }),
    [200],
  );

  return response.body;
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
    mocks.clerk.session(`user_${randomUUID()}`, null);

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
    const fixture = createFixture();
    const expected = {
      timezone: "America/Los_Angeles",
      pinnedAgentIds: ["agent_b", "agent_a"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 3,
    } satisfies UpdateUserPreferencesRequest;

    await updatePreferencesThroughApi(fixture, expected);

    await expect(getPreferencesThroughApi(fixture)).resolves.toStrictEqual(
      expected,
    );
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
    mocks.clerk.session(`user_${randomUUID()}`, null);

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
    const fixture = createFixture();
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
    const fixture = createFixture();
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
    const fixture = createFixture();
    const expected = {
      timezone: "Europe/London",
      pinnedAgentIds: ["agent-a", "agent-b"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 4,
    } satisfies UpdateUserPreferencesRequest;

    await expect(
      updatePreferencesThroughApi(fixture, expected),
    ).resolves.toStrictEqual(expected);
    await expect(getPreferencesThroughApi(fixture)).resolves.toStrictEqual(
      expected,
    );
  });

  it("updates timezone without changing existing preference fields", async () => {
    const fixture = createFixture();
    await updatePreferencesThroughApi(fixture, {
      timezone: "Asia/Tokyo",
      pinnedAgentIds: ["agent-old"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 2,
    });

    const response = await updatePreferencesThroughApi(fixture, {
      timezone: "America/Los_Angeles",
    });

    expect(response).toStrictEqual({
      timezone: "America/Los_Angeles",
      pinnedAgentIds: ["agent-old"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 2,
    });
  });

  it("updates pinnedAgentIds without changing existing preference fields", async () => {
    const fixture = createFixture();
    await updatePreferencesThroughApi(fixture, {
      timezone: "Asia/Tokyo",
      pinnedAgentIds: ["agent-old"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 2,
    });

    const response = await updatePreferencesThroughApi(fixture, {
      pinnedAgentIds: ["agent-new", "agent-extra"],
    });

    expect(response).toStrictEqual({
      timezone: "Asia/Tokyo",
      pinnedAgentIds: ["agent-new", "agent-extra"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 2,
    });
  });

  it("updates sendMode without changing existing preference fields", async () => {
    const fixture = createFixture();
    await updatePreferencesThroughApi(fixture, {
      timezone: "Asia/Tokyo",
      pinnedAgentIds: ["agent-old"],
      sendMode: "enter",
      captureNetworkBodiesRemaining: 2,
    });

    const response = await updatePreferencesThroughApi(fixture, {
      sendMode: "cmd-enter",
    });

    expect(response).toStrictEqual({
      timezone: "Asia/Tokyo",
      pinnedAgentIds: ["agent-old"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 2,
    });
  });

  it("updates captureNetworkBodiesRemaining without changing existing preference fields", async () => {
    const fixture = createFixture();
    await updatePreferencesThroughApi(fixture, {
      timezone: "Asia/Tokyo",
      pinnedAgentIds: ["agent-old"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 2,
    });

    const response = await updatePreferencesThroughApi(fixture, {
      captureNetworkBodiesRemaining: 7,
    });

    expect(response).toStrictEqual({
      timezone: "Asia/Tokyo",
      pinnedAgentIds: ["agent-old"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 7,
    });
  });
});
