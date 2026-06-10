import { randomUUID } from "node:crypto";

import { zeroSchedulesByNameContract } from "@vm0/api-contracts/contracts/zero-schedules";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
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

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroTokenWithoutScheduleDelete(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: ["schedule:read"],
    iat: seconds,
    exp: seconds + 60,
  });
}

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

  it("returns 404 for a non-existent schedule", async () => {
    const fixture = await track(
      store.set(seedSchedulesScenario$, { schedules: [] }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "non-existent" },
        query: { agentId: fixture.composeId },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
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

  it("returns 400 for an invalid query", async () => {
    const fixture = await track(
      store.set(seedSchedulesScenario$, { schedules: [] }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await client().delete({
      headers: { authorization: "Bearer clerk-session" },
      params: { name: "any" },
      query: { agentId: "not-a-uuid" },
    });
    expect(response.status).toBe(400);
    if (response.status === 400) {
      expect(response.body.error.code).toBe("BAD_REQUEST");
    }
  });

  it("returns 401 for unauthenticated requests", async () => {
    const response = await accept(
      client().delete({
        headers: {},
        params: { name: "any" },
        query: { agentId: randomUUID() },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for a zero token without schedule:delete", async () => {
    const fixture = await track(
      store.set(
        seedSchedulesScenario$,
        {
          schedules: [
            {
              name: "agent-cant-delete",
              cronExpression: "0 9 * * *",
              prompt: "Agent should not delete this",
            },
          ],
        },
        context.signal,
      ),
    );
    const token = zeroTokenWithoutScheduleDelete({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: `run_${randomUUID()}`,
    });

    const response = await accept(
      client().delete({
        headers: { authorization: `Bearer ${token}` },
        params: { name: "agent-cant-delete" },
        query: { agentId: fixture.composeId },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: schedule:delete",
        code: "FORBIDDEN",
      },
    });
  });
});
