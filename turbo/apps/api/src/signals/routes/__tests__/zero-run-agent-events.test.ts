import { randomUUID } from "node:crypto";

import { zeroRunAgentEventsContract } from "@vm0/api-contracts/contracts/zero-runs";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
// Reusing run-seeding helpers from the usage-insight test module — same
// fixture shape, same precedent as zero-runs-queue.test.ts (PR #12402)
// and zero-runs-runner.test.ts (PR #12408).
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

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

describe("GET /api/zero/runs/:id/telemetry/agent", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroRunAgentEventsContract);

    const response = await accept(
      client.getAgentEvents({
        params: { id: randomUUID() },
        query: { limit: 10, order: "desc" },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context })(zeroRunAgentEventsContract);

    const response = await accept(
      client.getAgentEvents({
        params: { id: randomUUID() },
        query: { limit: 10, order: "desc" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns agent events for an owned run", async () => {
    context.mocks.axiom.query.mockResolvedValue([]);
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

    const client = setupApp({ context })(zeroRunAgentEventsContract);

    const response = await accept(
      client.getAgentEvents({
        params: { id: runId },
        query: { limit: 10, order: "desc" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      events: [],
      hasMore: false,
      framework: "claude-code",
    });
  });

  it("returns 404 when the run does not exist", async () => {
    context.mocks.axiom.query.mockResolvedValue([]);
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunAgentEventsContract);

    const response = await accept(
      client.getAgentEvents({
        params: { id: randomUUID() },
        query: { limit: 10, order: "desc" },
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

  it("returns 404 when the run belongs to a different user (no existence leak)", async () => {
    context.mocks.axiom.query.mockResolvedValue([]);
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
        status: "running",
      },
      context.signal,
    );

    const otherFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(otherFixture.userId, otherFixture.orgId);

    const client = setupApp({ context })(zeroRunAgentEventsContract);

    const response = await accept(
      client.getAgentEvents({
        params: { id: runId },
        query: { limit: 10, order: "desc" },
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

  it("returns 403 for a sandbox token without agent-run:read capability", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId,
      capabilities: ["file:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    const client = setupApp({ context })(zeroRunAgentEventsContract);

    const response = await accept(
      client.getAgentEvents({
        params: { id: randomUUID() },
        query: { limit: 10, order: "desc" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent-run:read",
        code: "FORBIDDEN",
      },
    });
  });
});
