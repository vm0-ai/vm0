import { randomUUID } from "node:crypto";

import {
  zeroSchedulesByNameContract,
  zeroSchedulesMainContract,
} from "@vm0/api-contracts/contracts/zero-schedules";
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

// BDD migration of the legacy `zero-schedules-delete.test.ts`. The legacy
// "delete then re-delete returns 404" verification is replaced by
// asserting on the public list contract (deleted schedule is no longer
// listed). The 6 legacy `it()`s collapse into 2 BDD `it()`s.

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

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function deleteClient() {
  return setupApp({ context })(zeroSchedulesByNameContract);
}

function listClient() {
  return setupApp({ context })(zeroSchedulesMainContract);
}

describe("BDD DELETE /api/zero/schedules/:name — auth boundary", () => {
  it("returns 401 for unauthenticated request", async () => {
    // When + Then: no auth header → 401.
    const response = await accept(
      deleteClient().delete({
        headers: {},
        params: { name: "any" },
        query: { agentId: randomUUID() },
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});

const track = createFixtureTracker<SchedulesFixture>((fixture) => {
  return store.set(deleteSchedulesScenario$, fixture, context.signal);
});

describe("BDD DELETE /api/zero/schedules/:name — delete chain", () => {
  it("gwt-wt-wt: 404 missing → 403 zero-token w/o schedule:delete → 204 own (verified via list) → 204 re-delete (verified via list)", async () => {
    const c = deleteClient();
    const lister = listClient();

    // Given: a fresh user/org with no schedules.
    const emptyFixture = await track(
      store.set(seedSchedulesScenario$, { schedules: [] }, context.signal),
    );
    mocks.clerk.session(emptyFixture.userId, emptyFixture.orgId);

    // When + Then: delete on a non-existent schedule returns 404.
    const missing = await accept(
      c.delete({
        headers: authHeaders(),
        params: { name: "non-existent" },
        query: { agentId: emptyFixture.composeId },
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });

    // Given: a schedule owned by the user and a zero token without
    // schedule:delete capability.
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
    const token = zeroTokenWithoutScheduleDelete({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: `run_${randomUUID()}`,
    });

    // When + Then: zero token without schedule:delete gets 403.
    const forbidden = await accept(
      c.delete({
        headers: { authorization: `Bearer ${token}` },
        params: { name: "to-delete" },
        query: { agentId: fixture.composeId },
      }),
      [403],
    );
    expect(forbidden.body).toStrictEqual({
      error: {
        message: "Missing required capability: schedule:delete",
        code: "FORBIDDEN",
      },
    });

    // Given: a user-authenticated session, the schedule is still present.
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const beforeList = await accept(
      lister.list({ headers: authHeaders() }),
      [200],
    );
    const beforeRow = beforeList.body.schedules.find((entry) => {
      return entry.name === "to-delete";
    });
    expect(beforeRow?.name).toBe("to-delete");

    // When: the caller deletes the schedule.
    const deleted = await accept(
      c.delete({
        headers: authHeaders(),
        params: { name: "to-delete" },
        query: { agentId: fixture.composeId },
      }),
      [204],
    );
    expect(deleted.body).toBeUndefined();

    // Then: the public list contract no longer reports the schedule.
    const afterList = await accept(
      lister.list({ headers: authHeaders() }),
      [200],
    );
    const survivor = afterList.body.schedules.find((entry) => {
      return entry.name === "to-delete";
    });
    expect(survivor).toBeUndefined();

    // When: the caller deletes again (idempotent — schedule is gone).
    const idempotent = await accept(
      c.delete({
        headers: authHeaders(),
        params: { name: "to-delete" },
        query: { agentId: fixture.composeId },
      }),
      [404],
    );
    expect(idempotent.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
  });
});
