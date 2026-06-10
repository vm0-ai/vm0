import { zeroRunsByIdContract } from "@vm0/api-contracts/contracts/zero-runs";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
// Reusing run-seeding helpers from the usage-insight test module — same
// fixture shape (orgId/userId pair, then compose+run inserts), no need to
// duplicate. Same precedent as zero-runs-runner.test.ts (PR #12408).
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/runs/:id", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("returns 404 when the run belongs to a different user (no existence leak)", async () => {
    const ownerFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const compose = await store.set(
      seedCompose$,
      { orgId: ownerFixture.orgId, userId: ownerFixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: ownerFixture.orgId,
        userId: ownerFixture.userId,
        composeId: compose.composeId,
        status: "completed",
      },
      context.signal,
    );

    const otherFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(otherFixture.userId, otherFixture.orgId);

    const client = setupApp({ context })(zeroRunsByIdContract);

    const response = await accept(
      client.getById({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Agent run not found",
        code: "NOT_FOUND",
      },
    });
  });

  it("returns the run details", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const compose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: compose.composeId,
        status: "running",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunsByIdContract);

    const response = await accept(
      client.getById({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.runId).toBe(runId);
    expect(response.body.status).toBe("running");
    expect(response.body.prompt).toBe("test prompt");
  });
});
