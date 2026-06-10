import { zeroSchedulesEnableContract } from "@vm0/api-contracts/contracts/zero-schedules";
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

describe("POST /api/zero/schedules/:name/disable", () => {
  const track = createFixtureTracker<SchedulesFixture>((fixture) => {
    return store.set(deleteSchedulesScenario$, fixture, context.signal);
  });

  const client = () => {
    return setupApp({ context })(zeroSchedulesEnableContract);
  };

  it("disables an enabled schedule", async () => {
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

    const response = await accept(
      client().disable({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "to-disable" },
        body: { agentId: fixture.composeId },
      }),
      [200],
    );

    expect(response.body.enabled).toBeFalsy();
    expect(response.body.retryStartedAt).toBeNull();
  });

  it("disables schedule looked up by compose agentId", async () => {
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().disable({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "dis-agentid" },
        body: { agentId: fixture.composeId },
      }),
      [200],
    );

    expect(response.body.enabled).toBeFalsy();
  });
});
