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

// BDD migration of the legacy `zero-user-preferences.test.ts`.
// The 12 legacy `it()`s collapse into 3 BDD `it()`s: (1)
// GET chain (401 unauth → 401 no-org → 200 persisted
// preferences → 200 defaults when the org member metadata
// row does not exist), (2) POST auth + 400 chain (401
// unauth → 401 no-org → 400 invalid timezone → 400 empty
// body), (3) POST 200 success chain (200 creates
// preferences with all supported fields + GET echoes → 200
// updates timezone without changing other fields → 200
// updates pinnedAgentIds without changing other fields →
// 200 updates sendMode without changing other fields → 200
// updates captureNetworkBodiesRemaining without changing
// other fields).
//
// Service-Level Exception: `orgMembersMetadata` rows are
// seeded directly via `writeDb$` (via `seedUserPreferences$`)
// because no public route creates a preference row out of
// band.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const track = createFixtureTracker<UserDataFixture>((fixture) => {
  return store.set(deleteUserData$, fixture, context.signal);
});

function client() {
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

describe("BDD GET /api/zero/user-preferences — auth + 200 chain", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org → 200 persisted preferences → 200 defaults when the row does not exist", async () => {
    const c = client();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(c.get({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    // Given: a session with a user but no org.
    const noOrgFx = await track(
      store.set(seedUserPreferences$, {}, context.signal),
    );
    mocks.clerk.session(noOrgFx.userId, null);

    // When + Then: still 401.
    const noOrg = await accept(c.get({ headers: authHeaders() }), [401]);
    expect(noOrg.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    // Given: a user with persisted preferences.
    const persistedFx = await track(
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
    mocks.clerk.session(persistedFx.userId, persistedFx.orgId);

    // When + Then: 200 with the persisted preferences.
    const persisted = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(persisted.body).toStrictEqual({
      timezone: "America/Los_Angeles",
      pinnedAgentIds: ["agent_b", "agent_a"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 3,
    });

    // Given: a fresh org/user with no preference row.
    const defaultsOrgId = `org_${randomUUID()}`;
    const defaultsUserId = `user_${randomUUID()}`;
    mocks.clerk.session(defaultsUserId, defaultsOrgId);

    // When + Then: 200 with default values.
    const defaults = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(defaults.body).toStrictEqual({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
      captureNetworkBodiesRemaining: 0,
    });
  });
});

describe("BDD POST /api/zero/user-preferences — auth + 400 chain", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org → 400 invalid timezone → 400 empty body", async () => {
    const c = client();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      c.update({
        headers: {},
        body: { timezone: "America/New_York" },
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    // Given: a session with a user but no org.
    const noOrgFx = await track(
      store.set(seedUserPreferences$, {}, context.signal),
    );
    mocks.clerk.session(noOrgFx.userId, null);

    // When + Then: still 401.
    const noOrg = await accept(
      c.update({
        headers: authHeaders(),
        body: { timezone: "America/New_York" },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    // Given: a user with no preference row.
    const badTzFx = await track(
      store.set(seedUserPreferences$, {}, context.signal),
    );
    mocks.clerk.session(badTzFx.userId, badTzFx.orgId);

    // When + Then: 400 on invalid timezone.
    const badTz = await accept(
      c.update({
        headers: authHeaders(),
        body: { timezone: "Invalid/Timezone" },
      }),
      [400],
    );
    expect(badTz.body).toStrictEqual({
      error: {
        message: "Invalid request",
        code: "BAD_REQUEST",
      },
    });

    // When + Then: 400 on empty body.
    const empty = await accept(
      c.update({
        headers: authHeaders(),
        body: {},
      }),
      [400],
    );
    expect(empty.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("BDD POST /api/zero/user-preferences — 200 success chain", () => {
  it("gwt-wt-wt: 200 creates preferences with all supported fields + GET echoes → 200 updates timezone → 200 updates pinnedAgentIds → 200 updates sendMode → 200 updates captureNetworkBodiesRemaining", async () => {
    const c = client();

    // Given: a fresh user with no preference row.
    const createFx = await createTrackedFixture();
    mocks.clerk.session(createFx.userId, createFx.orgId);

    // When: update with all supported fields.
    const created = await accept(
      c.update({
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

    // Then: 200 + GET echoes the same values.
    const expected = {
      timezone: "Europe/London",
      pinnedAgentIds: ["agent-a", "agent-b"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 4,
    };
    expect(created.body).toStrictEqual(expected);
    const echoed = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(echoed.body).toStrictEqual(expected);

    // Given: a user with full preferences.
    const tzFx = await track(
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
    mocks.clerk.session(tzFx.userId, tzFx.orgId);

    // When + Then: 200 on timezone-only update; other fields
    // unchanged.
    const updatedTz = await accept(
      c.update({
        headers: authHeaders(),
        body: { timezone: "America/Los_Angeles" },
      }),
      [200],
    );
    expect(updatedTz.body).toStrictEqual({
      timezone: "America/Los_Angeles",
      pinnedAgentIds: ["agent-old"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 2,
    });

    // Given: a user with full preferences.
    const pinnedFx = await track(
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
    mocks.clerk.session(pinnedFx.userId, pinnedFx.orgId);

    // When + Then: 200 on pinnedAgentIds-only update; other
    // fields unchanged.
    const updatedPinned = await accept(
      c.update({
        headers: authHeaders(),
        body: { pinnedAgentIds: ["agent-new", "agent-extra"] },
      }),
      [200],
    );
    expect(updatedPinned.body).toStrictEqual({
      timezone: "Asia/Tokyo",
      pinnedAgentIds: ["agent-new", "agent-extra"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 2,
    });

    // Given: a user with full preferences.
    const sendFx = await track(
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
    mocks.clerk.session(sendFx.userId, sendFx.orgId);

    // When + Then: 200 on sendMode-only update; other fields
    // unchanged.
    const updatedSend = await accept(
      c.update({
        headers: authHeaders(),
        body: { sendMode: "cmd-enter" },
      }),
      [200],
    );
    expect(updatedSend.body).toStrictEqual({
      timezone: "Asia/Tokyo",
      pinnedAgentIds: ["agent-old"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 2,
    });

    // Given: a user with full preferences.
    const capFx = await track(
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
    mocks.clerk.session(capFx.userId, capFx.orgId);

    // When + Then: 200 on captureNetworkBodiesRemaining-only
    // update; other fields unchanged.
    const updatedCap = await accept(
      c.update({
        headers: authHeaders(),
        body: { captureNetworkBodiesRemaining: 7 },
      }),
      [200],
    );
    expect(updatedCap.body).toStrictEqual({
      timezone: "Asia/Tokyo",
      pinnedAgentIds: ["agent-old"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 7,
    });
  });
});
