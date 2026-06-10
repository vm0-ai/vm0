import { randomUUID } from "node:crypto";

import { zeroSchedulesEnableContract } from "@vm0/api-contracts/contracts/zero-schedules";
import { createStore } from "ccstate";
import { expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  type SchedulesFixture,
  deleteSchedulesScenario$,
  seedSchedulesScenario$,
} from "./helpers/zero-schedules";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-schedules-disable.test.ts`. The
// Given seeds schedules through the existing helper (recorded under
// "Open Helper Gaps" in `api.bdd.md` — no public route creates a
// schedule without going through the POST flow). All Then assertions
// are through the contract's POST /api/zero/schedules/:name/disable.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const track = createFixtureTracker<SchedulesFixture>((fixture) => {
  return store.set(deleteSchedulesScenario$, fixture, context.signal);
});

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroSchedulesEnableContract);
}

describe("BDD POST /api/zero/schedules/:name/disable — auth boundary", () => {
  it("returns 401 for unauthenticated request", async () => {
    const response = await accept(
      client().disable({
        headers: {},
        params: { name: "any" },
        body: { agentId: randomUUID() },
      }),
      [401],
    );
    expect(response.status).toBe(401);
  });
});

describe("BDD POST /api/zero/schedules/:name/disable — disable chain", () => {
  it("gwt-wt-wt: enable → disable by name → disable by agentId → 404 unknown", async () => {
    // Given: an enabled schedule is seeded.
    const fixture = await track(
      store.set(
        seedSchedulesScenario$,
        {
          schedules: [
            {
              name: "to-disable",
              cronExpression: "0 9 * * *",
              prompt: "Disable test",
              enabled: true,
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const c = client();

    // When + Then: disable by name flips the flag, clears the retry
    // start, and returns 200.
    const first = await accept(
      c.disable({
        headers: authHeaders(),
        params: { name: "to-disable" },
        body: { agentId: fixture.composeId },
      }),
      [200],
    );
    expect(first.body.enabled).toBeFalsy();
    expect(first.body.retryStartedAt).toBeNull();

    // Given: another schedule is seeded with a different name.
    const fixture2 = await track(
      store.set(
        seedSchedulesScenario$,
        {
          schedules: [
            {
              name: "dis-agentid",
              cronExpression: "0 9 * * *",
              prompt: "Disable via agentId",
              enabled: true,
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture2.userId, fixture2.orgId);

    // When + Then: disable-by-agentId path returns 200 with the flag
    // flipped.
    const second = await accept(
      c.disable({
        headers: authHeaders(),
        params: { name: "dis-agentid" },
        body: { agentId: fixture2.composeId },
      }),
      [200],
    );
    expect(second.body.enabled).toBeFalsy();

    // Given: an empty user (no schedules seeded).
    const fixture3 = await track(
      store.set(seedSchedulesScenario$, { schedules: [] }, context.signal),
    );
    mocks.clerk.session(fixture3.userId, fixture3.orgId);

    // When + Then: disable on a missing schedule returns 404.
    const missing = await accept(
      c.disable({
        headers: authHeaders(),
        params: { name: "non-existent" },
        body: { agentId: fixture3.composeId },
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });

    // When + Then: disable with a malformed body returns 400.
    const bad = await c.disable({
      headers: authHeaders(),
      params: { name: "any" },
      body: {} as { agentId: string },
    });
    expect(bad.status).toBe(400);
    if (bad.status === 400) {
      expect(bad.body.error.code).toBe("BAD_REQUEST");
    }
  });
});
