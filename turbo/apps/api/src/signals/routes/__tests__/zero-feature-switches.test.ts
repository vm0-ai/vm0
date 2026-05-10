import { randomUUID } from "node:crypto";

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteFeatureSwitches$,
  seedFeatureSwitches$,
  type FeatureSwitchesFixture,
} from "./helpers/zero-feature-switches";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

async function getRowSwitches(
  orgId: string,
  userId: string,
): Promise<Record<string, boolean> | undefined> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select({ switches: userFeatureSwitches.switches })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, orgId),
        eq(userFeatureSwitches.userId, userId),
      ),
    );
  return row ? (row.switches as Record<string, boolean>) : undefined;
}

describe("GET /api/zero/feature-switches", () => {
  const track = createFixtureTracker<FeatureSwitchesFixture>((fixture) => {
    return store.set(deleteFeatureSwitches$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroFeatureSwitchesContract);

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

  it("returns persisted feature switch overrides", async () => {
    const fixture = await track(
      store.set(
        seedFeatureSwitches$,
        {
          apiBackend: true,
          audioInput: false,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      switches: {
        apiBackend: true,
        audioInput: false,
      },
    });
  });

  it("returns empty switches when no override row exists", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ switches: {} });
  });
});

describe("POST /api/zero/feature-switches", () => {
  const track = createFixtureTracker<FeatureSwitchesFixture>((fixture) => {
    return store.set(deleteFeatureSwitches$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    const response = await accept(
      client.update({
        headers: {},
        body: { switches: { voiceChat: true } },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { switches: { voiceChat: true } },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("creates new switches for a user with no override row", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId, userId }));
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { switches: { voiceChat: true } },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ switches: { voiceChat: true } });

    await expect(getRowSwitches(orgId, userId)).resolves.toStrictEqual({
      voiceChat: true,
    });
  });

  it("merges with existing switches (preserves untouched keys)", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId, userId }));
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { switches: { voiceChat: true } },
      }),
      [200],
    );

    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { switches: { lab: false } },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      switches: { voiceChat: true, lab: false },
    });

    await expect(getRowSwitches(orgId, userId)).resolves.toStrictEqual({
      voiceChat: true,
      lab: false,
    });
  });

  it("overrides existing switch values for the same key", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId, userId }));
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { switches: { voiceChat: true } },
      }),
      [200],
    );

    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { switches: { voiceChat: false } },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ switches: { voiceChat: false } });

    await expect(getRowSwitches(orgId, userId)).resolves.toStrictEqual({
      voiceChat: false,
    });
  });

  it("returns updated switches on subsequent GET", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId, userId }));
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { switches: { voiceChat: true, lab: false } },
      }),
      [200],
    );

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body).toStrictEqual({
      switches: { voiceChat: true, lab: false },
    });
  });
});

describe("DELETE /api/zero/feature-switches", () => {
  const track = createFixtureTracker<FeatureSwitchesFixture>((fixture) => {
    return store.set(deleteFeatureSwitches$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    const response = await accept(client.delete({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    const response = await accept(
      client.delete({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("clears all overrides; subsequent GET returns empty switches", async () => {
    const fixture = await track(
      store.set(
        seedFeatureSwitches$,
        { voiceChat: true, lab: false },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    const deleteResponse = await accept(
      client.delete({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(deleteResponse.body).toStrictEqual({ deleted: true });

    await expect(
      getRowSwitches(fixture.orgId, fixture.userId),
    ).resolves.toBeUndefined();

    const getResponse = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(getResponse.body).toStrictEqual({ switches: {} });
  });
});
