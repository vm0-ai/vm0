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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("POST /api/zero/schedules/:name/enable", () => {
  const track = createFixtureTracker<SchedulesFixture>((fixture) => {
    return store.set(deleteSchedulesScenario$, fixture, context.signal);
  });

  const client = () => {
    return setupApp({ context })(zeroSchedulesEnableContract);
  };

  it("enables a disabled schedule and resets retry/failure state", async () => {
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

    const response = await accept(
      client().enable({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "to-enable" },
        body: { agentId: fixture.composeId },
      }),
      [200],
    );

    expect(response.body.enabled).toBeTruthy();
    expect(response.body.retryStartedAt).toBeNull();
    expect(response.body.consecutiveFailures).toBe(0);
    expect(response.body.nextRunAt).not.toBeNull();
  });

  it("returns 404 for non-existent schedule", async () => {
    const fixture = await track(
      store.set(seedSchedulesScenario$, { schedules: [] }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().enable({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "non-existent" },
        body: { agentId: fixture.composeId },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
  });

  it("enables schedule looked up by compose agentId", async () => {
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().enable({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "enable-agentid" },
        body: { agentId: fixture.composeId },
      }),
      [200],
    );

    expect(response.body.enabled).toBeTruthy();
  });

  it("returns 400 for invalid body", async () => {
    const fixture = await track(
      store.set(seedSchedulesScenario$, { schedules: [] }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await client().enable({
      headers: { authorization: "Bearer clerk-session" },
      params: { name: "any" },
      body: {} as { agentId: string },
    });
    expect(response.status).toBe(400);
    if (response.status === 400) {
      expect(response.body.error.code).toBe("BAD_REQUEST");
    }
  });

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

  it("returns 400 SCHEDULE_PAST when one-time schedule atTime has passed", async () => {
    const pastDate = new Date(now() - 86_400_000);
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().enable({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "past-once" },
        body: { agentId: fixture.composeId },
      }),
      [400],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: "Schedule time has already passed",
        code: "SCHEDULE_PAST",
      },
    });
  });
});
