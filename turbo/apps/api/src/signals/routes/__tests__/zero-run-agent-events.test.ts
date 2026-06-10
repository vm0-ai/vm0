import { randomUUID } from "node:crypto";

import { zeroRunAgentEventsContract } from "@vm0/api-contracts/contracts/zero-runs";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
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

  it("returns the framework from legacy agent compose content", async () => {
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
    await store
      .set(writeDb$)
      .update(agentComposeVersions)
      .set({ content: { agent: { framework: "codex" } } })
      .where(eq(agentComposeVersions.composeId, compose.composeId));
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
      framework: "codex",
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

  it("waits for the axiom watermark and passes noCache when lastEventSequence is set", async () => {
    // First call = visibility poll (returns the contiguous prefix). Second
    // call = the actual events query, which must receive { noCache: true }.
    // Trailing default fails fast and clearly if a refactor ever extends the
    // visibility poll past the first call (rather than returning undefined).
    context.mocks.axiom.query
      .mockResolvedValueOnce([{ sequenceNumber: 0 }, { sequenceNumber: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
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
        status: "completed",
        lastEventSequence: 1,
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

    expect(response.body.events).toStrictEqual([]);
    // The visibility poll uses the per-runId visibility query with noCache.
    // The actual events query also gets noCache (the wait was attempted).
    expect(context.mocks.axiom.query).toHaveBeenCalledTimes(2);
    const calls = context.mocks.axiom.query.mock.calls;
    expect(calls[0]?.[0]).toContain("project sequenceNumber");
    expect(calls[0]?.[1]).toStrictEqual({ noCache: true });
    expect(calls[1]?.[0]).toContain(`runId == "${runId}"`);
    expect(calls[1]?.[1]).toStrictEqual({ noCache: true });
  });

  it("does not wait or pass noCache when watermark target is null", async () => {
    context.mocks.axiom.query.mockResolvedValue([]);
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const compose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    // lastEventSequence: 3 + since: 10 (desc) → since >= last → target = null
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: compose.composeId,
        status: "completed",
        lastEventSequence: 3,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunAgentEventsContract);

    await accept(
      client.getAgentEvents({
        params: { id: runId },
        query: { limit: 10, order: "desc", since: 10 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    // Only the events query — no visibility poll. And no noCache option.
    expect(context.mocks.axiom.query).toHaveBeenCalledTimes(1);
    const [apl, opts] = context.mocks.axiom.query.mock.calls[0] ?? [];
    expect(apl).toContain(`runId == "${runId}"`);
    expect(opts).toBeUndefined();
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
