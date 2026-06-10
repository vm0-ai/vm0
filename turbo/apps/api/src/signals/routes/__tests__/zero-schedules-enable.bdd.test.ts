import { randomUUID } from "node:crypto";

import { zeroSchedulesEnableContract } from "@vm0/api-contracts/contracts/zero-schedules";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now, nowDate } from "../../../lib/time";
import {
  type SchedulesFixture,
  deleteSchedulesScenario$,
  seedSchedulesScenario$,
} from "./helpers/zero-schedules";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-schedules-enable.test.ts`. The
// Given seeds schedules through the existing helper (recorded under
// "Open Helper Gaps" in `api.bdd.md` — no public route creates a
// schedule without going through the POST flow). All Then assertions
// are through the contract's POST /api/zero/schedules/:name/enable.

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

describe("BDD POST /api/zero/schedules/:name/enable — auth boundary", () => {
  it("returns 401 for unauthenticated request", async () => {
    const response = await accept(
      client().enable({
        headers: {},
        params: { name: "any" },
        body: { agentId: randomUUID() },
      }),
      [401],
    );
    expect(response.status).toBe(401);
  });
});

describe("BDD POST /api/zero/schedules/:name/enable — enable chain", () => {
  it("gwt-wt-wt: enable-by-name → 404 missing → enable-by-agentId → 400 bad body → 400 SCHEDULE_PAST", async () => {
    // Given: a disabled schedule with retry/failure state, seeded
    // through the helper. Enabling should reset the retry state and
    // compute a fresh `nextRunAt`.
    const fixture = await track(
      store.set(
        seedSchedulesScenario$,
        {
          schedules: [
            {
              name: "to-enable",
              cronExpression: "0 9 * * *",
              prompt: "Enable test",
              enabled: false,
              retryStartedAt: nowDate(),
              consecutiveFailures: 2,
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const c = client();

    // When + Then: enable by name returns 200 with retry/failure
    // state cleared and a fresh nextRunAt.
    const first = await accept(
      c.enable({
        headers: authHeaders(),
        params: { name: "to-enable" },
        body: { agentId: fixture.composeId },
      }),
      [200],
    );
    expect(first.body.enabled).toBeTruthy();
    expect(first.body.retryStartedAt).toBeNull();
    expect(first.body.consecutiveFailures).toBe(0);
    expect(first.body.nextRunAt).not.toBeNull();

    // Given: an empty user (no schedules seeded).
    const emptyFixture = await track(
      store.set(seedSchedulesScenario$, { schedules: [] }, context.signal),
    );
    mocks.clerk.session(emptyFixture.userId, emptyFixture.orgId);

    // When + Then: enable on a missing schedule returns 404.
    const missing = await accept(
      c.enable({
        headers: authHeaders(),
        params: { name: "non-existent" },
        body: { agentId: emptyFixture.composeId },
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });

    // Given: a disabled schedule is seeded.
    const agentIdFixture = await track(
      store.set(
        seedSchedulesScenario$,
        {
          schedules: [
            {
              name: "enable-agentid",
              cronExpression: "0 9 * * *",
              prompt: "Enable via agentId",
              enabled: false,
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(agentIdFixture.userId, agentIdFixture.orgId);

    // When + Then: enable-by-agentId returns 200 with the flag
    // flipped.
    const agentId = await accept(
      c.enable({
        headers: authHeaders(),
        params: { name: "enable-agentid" },
        body: { agentId: agentIdFixture.composeId },
      }),
      [200],
    );
    expect(agentId.body.enabled).toBeTruthy();

    // When + Then: enable with a malformed body returns 400.
    const bad = await c.enable({
      headers: authHeaders(),
      params: { name: "any" },
      body: {} as { agentId: string },
    });
    expect(bad.status).toBe(400);
    if (bad.status === 400) {
      expect(bad.body.error.code).toBe("BAD_REQUEST");
    }

    // Given: a one-time schedule whose atTime has already passed.
    const pastDate = new Date(now() - 86_400_000);
    const pastFixture = await track(
      store.set(
        seedSchedulesScenario$,
        {
          schedules: [
            {
              name: "past-once",
              prompt: "Past one-time",
              triggerType: "once",
              atTime: pastDate,
              enabled: false,
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(pastFixture.userId, pastFixture.orgId);

    // When + Then: enable returns 400 SCHEDULE_PAST.
    const past = await accept(
      c.enable({
        headers: authHeaders(),
        params: { name: "past-once" },
        body: { agentId: pastFixture.composeId },
      }),
      [400],
    );
    expect(past.body).toStrictEqual({
      error: {
        message: "Schedule time has already passed",
        code: "SCHEDULE_PAST",
      },
    });
  });
});
