import { randomUUID } from "node:crypto";

import { zeroSchedulesMainContract } from "@vm0/api-contracts/contracts/zero-schedules";
import { createStore } from "ccstate";

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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/schedules", () => {
  const track = createFixtureTracker<SchedulesFixture>((fixture) => {
    return store.set(deleteSchedulesScenario$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroSchedulesMainContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroSchedulesMainContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns the list of schedules for the org member", async () => {
    const fixture = await track(
      store.set(
        seedSchedulesScenario$,
        {
          displayName: "Test Agent",
          schedules: [
            {
              name: "list-test-1",
              cronExpression: "0 9 * * *",
              prompt: "First",
            },
            {
              name: "list-test-2",
              cronExpression: "0 10 * * *",
              prompt: "Second",
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSchedulesMainContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.schedules).toHaveLength(2);
    const byName = new Map(
      response.body.schedules.map((s) => {
        return [s.name, s] as const;
      }),
    );
    expect(byName.get("list-test-1")).toMatchObject({
      agentId: fixture.composeId,
      displayName: "Test Agent",
      userId: fixture.userId,
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      prompt: "First",
      enabled: true,
    });
    expect(byName.get("list-test-2")).toMatchObject({
      agentId: fixture.composeId,
      displayName: "Test Agent",
      userId: fixture.userId,
      triggerType: "cron",
      cronExpression: "0 10 * * *",
      timezone: "UTC",
      prompt: "Second",
      enabled: true,
    });
  });

  it("returns an empty array when the user has no schedules", async () => {
    const fixture = await track(
      store.set(seedSchedulesScenario$, { schedules: [] }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSchedulesMainContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ schedules: [] });
  });
});
