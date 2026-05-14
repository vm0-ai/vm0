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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

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

describe("GET /api/zero/runs/:id/network", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroRunNetworkLogsContract);

    const response = await accept(
      client.getNetworkLogs({
        params: { id: randomUUID() },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context })(zeroRunNetworkLogsContract);

    const response = await accept(
      client.getNetworkLogs({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
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

    const client = setupApp({ context })(zeroRunNetworkLogsContract);

    const response = await accept(
      client.getNetworkLogs({
        params: { id: randomUUID() },
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

  it("returns 404 when the run is not found", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunNetworkLogsContract);

    const response = await accept(
      client.getNetworkLogs({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns network logs for a run", async () => {
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
      },
      context.signal,
    );

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

    const client = setupApp({ context })(zeroRunNetworkLogsContract);

    const response = await accept(
      client.getNetworkLogs({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.networkLogs).toHaveLength(3);
    expect(response.body.hasMore).toBeFalsy();
    expect(response.body.networkLogs[0]?.type).toBe("http");
    expect(response.body.networkLogs[0]?.method).toBe("GET");
    expect(response.body.networkLogs[0]?.url).toBe(
      "https://api.example.com/data",
    );
    expect(response.body.networkLogs[0]?.status).toBe(200);
    expect(response.body.networkLogs[1]?.type).toBe("tcp");
    expect(response.body.networkLogs[1]?.host).toBe("redis.example.com");
    expect(response.body.networkLogs[1]?.port).toBe(6379);
    expect(response.body.networkLogs[2]?.type).toBe("dns");
    expect(response.body.networkLogs[2]?.host).toBe("api.github.com");
    expect(response.body.networkLogs[2]?.dns_event).toBe("reply");
    expect(response.body.networkLogs[2]?.dns_result).toBe("140.82.121.4");
    expect(response.body.networkLogs[2]?.dns_serial).toBe("42");
  });

  it("omits sparse null Axiom fields before response validation", async () => {
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
      },
      context.signal,
    );

    context.mocks.axiom.query.mockResolvedValue([
      makeAxiomEvent({
        runId,
        userId: fixture.userId,
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunNetworkLogsContract);

    const response = await accept(
      client.getNetworkLogs({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.networkLogs).toHaveLength(1);
    expect(response.body.networkLogs[0]).toMatchObject({
      firewall_params: {
        owner: "vm0-ai",
        repo: "vm0",
      },
      request_headers: {
        accept: "application/json",
      },
      response_headers: {
        "content-type": "application/json",
      },
    });
    expect(response.body.networkLogs[0]?.auth_cache_hit).toBeUndefined();
    expect(response.body.networkLogs[0]?.auth_resolved_secrets).toBeUndefined();
    expect(
      response.body.networkLogs[0]?.response_body_encoding,
    ).toBeUndefined();
  });

  it("returns empty array when no logs", async () => {
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
      },
      context.signal,
    );

    context.mocks.axiom.query.mockResolvedValue([]);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunNetworkLogsContract);

    const response = await accept(
      client.getNetworkLogs({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.networkLogs).toStrictEqual([]);
    expect(response.body.hasMore).toBeFalsy();
  });

  it("sets hasMore when results exceed limit", async () => {
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
      },
      context.signal,
    );

    context.mocks.axiom.query.mockResolvedValue(
      Array.from({ length: 3 }, (_, index) => {
        return makeAxiomEvent({
          runId,
          userId: fixture.userId,
          url: `https://api.example.com/${index}`,
        });
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunNetworkLogsContract);

    const response = await accept(
      client.getNetworkLogs({
        params: { id: runId },
        query: { limit: 2 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.networkLogs).toHaveLength(2);
    expect(response.body.hasMore).toBeTruthy();
  });
});
