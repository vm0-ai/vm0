import { randomUUID } from "node:crypto";

import { zeroRunNetworkLogsContract } from "@vm0/api-contracts/contracts/zero-runs";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
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

// BDD migration of the legacy `zero-run-network-logs.test.ts`.
// The 9 legacy `it()`s collapse into 2 BDD `it()`s: (1)
// auth boundary (401 unauth → 401 no-org), (2) full
// coverage chain (403 sandbox no capability → 404 unknown
// → 404 cross-user → 200 3 events http + tcp + dns → 200
// sparse null Axiom fields omitted → 200 empty → 200
// hasMore when results exceed limit).
//
// The Given uses `seedUsageInsightFixture$` +
// `seedCompose$` + `seedRun$` direct DB writes (Open
// Helper Gaps). The Then step is always through the
// public `zeroRunNetworkLogsContract.getNetworkLogs`
// response. The Axiom mock is reset before each chain
// step to avoid cross-test pollution.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroRunNetworkLogsContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function makeAxiomEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _time: "2026-04-01T10:00:00Z",
    runId: "test-run",
    userId: "test-user",
    type: "http",
    action: "ALLOW",
    method: "GET",
    url: "https://api.example.com/data",
    host: "api.example.com",
    port: 443,
    status: 200,
    latency_ms: 150,
    request_size: 100,
    response_size: 2048,
    ...overrides,
  };
}

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

describe("BDD GET /api/zero/runs/:id/network — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = client();

    // When + Then: no auth header → 401.
    const unauth = await accept(
      c.getNetworkLogs({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session that resolves to a user without an org.
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    // When + Then: still 401.
    const noOrg = await accept(
      c.getNetworkLogs({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD GET /api/zero/runs/:id/network — full coverage chain", () => {
  it("gwt-wt-wt: 403 sandbox no capability → 404 unknown → 404 cross-user → 200 3 events → 200 sparse nulls omitted → 200 empty → 200 hasMore when limit exceeded", async () => {
    // Given: a sandbox token with `file:read` but not
    // `agent-run:read`.
    const seconds = currentSecond();
    const sandboxToken = signSandboxJwtForTests({
      scope: "zero",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      capabilities: ["file:read"],
      iat: seconds,
      exp: seconds + 60,
    });
    const c = client();

    // When + Then: 403.
    const sandbox = await accept(
      c.getNetworkLogs({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${sandboxToken}` },
      }),
      [403],
    );
    expect(sandbox.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent-run:read",
        code: "FORBIDDEN",
      },
    });

    // Given: a valid session with no run.
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 404 — unknown id.
    const unknown = await accept(
      c.getNetworkLogs({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(unknown.body.error.code).toBe("NOT_FOUND");

    // Given: a run owned by another user.
    const ownerFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const ownerCompose = await store.set(
      seedCompose$,
      { orgId: ownerFixture.orgId, userId: ownerFixture.userId },
      context.signal,
    );
    const { runId: ownerRunId } = await store.set(
      seedRun$,
      {
        orgId: ownerFixture.orgId,
        userId: ownerFixture.userId,
        composeId: ownerCompose.composeId,
        status: "completed",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 404 — a different user gets no
    // existence leak.
    const crossUser = await accept(
      c.getNetworkLogs({
        params: { id: ownerRunId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUser.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });

    // Given: an owned run with 3 network events (http +
    // tcp + dns) in Axiom.
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
      },
      context.signal,
    );
    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query.mockResolvedValue([
      makeAxiomEvent({ runId, userId: fixture.userId }),
      makeAxiomEvent({
        runId,
        userId: fixture.userId,
        type: "tcp",
        action: undefined,
        method: undefined,
        url: undefined,
        status: undefined,
        host: "redis.example.com",
        port: 6379,
      }),
      makeAxiomEvent({
        runId,
        userId: fixture.userId,
        type: "dns",
        action: undefined,
        method: undefined,
        url: undefined,
        status: undefined,
        host: "api.github.com",
        port: 53,
        dns_event: "reply",
        dns_result: "140.82.121.4",
        dns_serial: "42",
      }),
    ]);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 200 — 3 events, no hasMore.
    const events = await accept(
      c.getNetworkLogs({
        params: { id: runId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(events.body.networkLogs).toHaveLength(3);
    expect(events.body.hasMore).toBeFalsy();
    expect(events.body.networkLogs[0]?.type).toBe("http");
    expect(events.body.networkLogs[0]?.method).toBe("GET");
    expect(events.body.networkLogs[0]?.url).toBe(
      "https://api.example.com/data",
    );
    expect(events.body.networkLogs[0]?.status).toBe(200);
    expect(events.body.networkLogs[1]?.type).toBe("tcp");
    expect(events.body.networkLogs[1]?.host).toBe("redis.example.com");
    expect(events.body.networkLogs[1]?.port).toBe(6379);
    expect(events.body.networkLogs[2]?.type).toBe("dns");
    expect(events.body.networkLogs[2]?.host).toBe("api.github.com");
    expect(events.body.networkLogs[2]?.dns_event).toBe("reply");
    expect(events.body.networkLogs[2]?.dns_result).toBe("140.82.121.4");
    expect(events.body.networkLogs[2]?.dns_serial).toBe("42");

    // Given: a fresh run with a sparse event (some null
    // Axiom fields).
    const sparseFx = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const sparseCompose = await store.set(
      seedCompose$,
      { orgId: sparseFx.orgId, userId: sparseFx.userId },
      context.signal,
    );
    const { runId: sparseRunId } = await store.set(
      seedRun$,
      {
        orgId: sparseFx.orgId,
        userId: sparseFx.userId,
        composeId: sparseCompose.composeId,
        status: "completed",
      },
      context.signal,
    );
    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query.mockResolvedValue([
      makeAxiomEvent({
        runId: sparseRunId,
        userId: sparseFx.userId,
        browser_user_agent: true,
        auth_cache_hit: null,
        auth_resolved_secrets: null,
        firewall_params: {
          owner: "vm0-ai",
          repo: "vm0",
          branch: null,
        },
        request_headers: {
          accept: "application/json",
          authorization: null,
        },
        response_headers: {
          "content-type": "application/json",
          server: null,
        },
        response_body_encoding: null,
      }),
    ]);
    mocks.clerk.session(sparseFx.userId, sparseFx.orgId);

    // When + Then: 200 — null fields are dropped.
    const sparse = await accept(
      c.getNetworkLogs({
        params: { id: sparseRunId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(sparse.body.networkLogs).toHaveLength(1);
    expect(sparse.body.networkLogs[0]).toMatchObject({
      firewall_params: { owner: "vm0-ai", repo: "vm0" },
      request_headers: { accept: "application/json" },
      response_headers: { "content-type": "application/json" },
      browser_user_agent: true,
    });
    expect(sparse.body.networkLogs[0]?.auth_cache_hit).toBeUndefined();
    expect(sparse.body.networkLogs[0]?.auth_resolved_secrets).toBeUndefined();
    expect(sparse.body.networkLogs[0]?.response_body_encoding).toBeUndefined();

    // Given: a fresh run with no events.
    const emptyFx = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const emptyCompose = await store.set(
      seedCompose$,
      { orgId: emptyFx.orgId, userId: emptyFx.userId },
      context.signal,
    );
    const { runId: emptyRunId } = await store.set(
      seedRun$,
      {
        orgId: emptyFx.orgId,
        userId: emptyFx.userId,
        composeId: emptyCompose.composeId,
        status: "completed",
      },
      context.signal,
    );
    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query.mockResolvedValue([]);
    mocks.clerk.session(emptyFx.userId, emptyFx.orgId);

    // When + Then: 200 — empty.
    const empty = await accept(
      c.getNetworkLogs({
        params: { id: emptyRunId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(empty.body.networkLogs).toStrictEqual([]);
    expect(empty.body.hasMore).toBeFalsy();

    // Given: a fresh run with 3 events and a limit of 2.
    const limitFx = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const limitCompose = await store.set(
      seedCompose$,
      { orgId: limitFx.orgId, userId: limitFx.userId },
      context.signal,
    );
    const { runId: limitRunId } = await store.set(
      seedRun$,
      {
        orgId: limitFx.orgId,
        userId: limitFx.userId,
        composeId: limitCompose.composeId,
        status: "completed",
      },
      context.signal,
    );
    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query.mockResolvedValue(
      Array.from({ length: 3 }, (_, index) => {
        return makeAxiomEvent({
          runId: limitRunId,
          userId: limitFx.userId,
          url: `https://api.example.com/${index}`,
        });
      }),
    );
    mocks.clerk.session(limitFx.userId, limitFx.orgId);

    // When + Then: 200 — hasMore is true (3 > 2).
    const hasMore = await accept(
      c.getNetworkLogs({
        params: { id: limitRunId },
        query: { limit: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(hasMore.body.networkLogs).toHaveLength(2);
    expect(hasMore.body.hasMore).toBeTruthy();
  });
});
