import { zeroSchedulesByNameContract } from "@vm0/api-contracts/contracts/zero-schedules";
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

describe("DELETE /api/zero/schedules/:name", () => {
  const track = createFixtureTracker<SchedulesFixture>((fixture) => {
    return store.set(deleteSchedulesScenario$, fixture, context.signal);
  });

  const client = () => {
    return setupApp({ context })(zeroSchedulesByNameContract);
  };

  it("deletes a schedule and returns 204", async () => {
    const fixture = await track(
      store.set(
        seedSchedulesScenario$,
        {
          schedules: [
            {
              name: "to-delete",
              cronExpression: "0 9 * * *",
              prompt: "Will be deleted",
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "to-delete" },
        query: { agentId: fixture.composeId },
      }),
      [204],
    );

    expect(response.body).toBeUndefined();

    const repeatResponse = await accept(
      client().delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "to-delete" },
        query: { agentId: fixture.composeId },
      }),
      [404],
    );
    expect(repeatResponse.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
  });

  it("deletes a schedule looked up by compose agentId", async () => {
    const fixture = await track(
      store.set(
        seedSchedulesScenario$,
        {
          schedules: [
            {
              name: "del-agent-id",
              cronExpression: "0 9 * * *",
              prompt: "Will be deleted via agentId",
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "del-agent-id" },
        query: { agentId: fixture.composeId },
      }),
      [204],
    );

    expect(response.status).toBe(204);
  });
});
