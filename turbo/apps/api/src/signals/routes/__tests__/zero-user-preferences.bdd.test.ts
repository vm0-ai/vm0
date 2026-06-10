import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { zeroUserPreferencesContract } from "@vm0/api-contracts/contracts/zero-user-preferences";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function apiClient() {
  return setupApp({ context })(zeroUserPreferencesContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("/api/zero/user-preferences BDD", () => {
  it("requires authentication and an active organization", async () => {
    const client = apiClient();

    const getUnauthenticated = await accept(client.get({ headers: {} }), [401]);
    const updateUnauthenticated = await accept(
      client.update({
        headers: {},
        body: { timezone: "America/New_York" },
      }),
      [401],
    );

    expect(getUnauthenticated.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
    expect(updateUnauthenticated.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const getNoOrg = await accept(
      client.get({ headers: authHeaders() }),
      [401],
    );
    const updateNoOrg = await accept(
      client.update({
        headers: authHeaders(),
        body: { timezone: "America/New_York" },
      }),
      [401],
    );

    expect(getNoOrg.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
    expect(updateNoOrg.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("creates preferences, rejects invalid updates, preserves existing fields, and reads the final state", async () => {
    const client = apiClient();
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const defaults = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );

    expect(defaults.body).toStrictEqual({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
      captureNetworkBodiesRemaining: 0,
    });

    const invalidTimezone = await accept(
      client.update({
        headers: authHeaders(),
        body: { timezone: "Invalid/Timezone" },
      }),
      [400],
    );
    const emptyUpdate = await accept(
      client.update({
        headers: authHeaders(),
        body: {},
      }),
      [400],
    );

    expect(invalidTimezone.body).toStrictEqual({
      error: {
        message: "Invalid request",
        code: "BAD_REQUEST",
      },
    });
    expect(emptyUpdate.body.error.code).toBe("BAD_REQUEST");

    const created = await accept(
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

    expect(created.body).toStrictEqual({
      timezone: "Europe/London",
      pinnedAgentIds: ["agent-a", "agent-b"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 4,
    });

    const timezoneUpdated = await accept(
      client.update({
        headers: authHeaders(),
        body: { timezone: "America/Los_Angeles" },
      }),
      [200],
    );

    expect(timezoneUpdated.body).toStrictEqual({
      timezone: "America/Los_Angeles",
      pinnedAgentIds: ["agent-a", "agent-b"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 4,
    });

    const pinnedUpdated = await accept(
      client.update({
        headers: authHeaders(),
        body: { pinnedAgentIds: ["agent-new", "agent-extra"] },
      }),
      [200],
    );

    expect(pinnedUpdated.body).toStrictEqual({
      timezone: "America/Los_Angeles",
      pinnedAgentIds: ["agent-new", "agent-extra"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 4,
    });

    const sendModeUpdated = await accept(
      client.update({
        headers: authHeaders(),
        body: { sendMode: "enter" },
      }),
      [200],
    );

    expect(sendModeUpdated.body).toStrictEqual({
      timezone: "America/Los_Angeles",
      pinnedAgentIds: ["agent-new", "agent-extra"],
      sendMode: "enter",
      captureNetworkBodiesRemaining: 4,
    });

    const captureUpdated = await accept(
      client.update({
        headers: authHeaders(),
        body: { captureNetworkBodiesRemaining: 7 },
      }),
      [200],
    );
    const readBack = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );

    expect(captureUpdated.body).toStrictEqual({
      timezone: "America/Los_Angeles",
      pinnedAgentIds: ["agent-new", "agent-extra"],
      sendMode: "enter",
      captureNetworkBodiesRemaining: 7,
    });
    expect(readBack.body).toStrictEqual(captureUpdated.body);
  });
});
