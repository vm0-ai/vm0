import { randomUUID } from "node:crypto";

import {
  runAgentEventsContract,
  runEventsContract,
  runMetricsContract,
  runNetworkLogsContract,
  runSystemLogContract,
  runTelemetryContract,
} from "@vm0/api-contracts/contracts/runs";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { sandboxTelemetry } from "@vm0/db/schema/sandbox-telemetry";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { ROUTES } from "../../route";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function makeAxiomEvent(
  runId: string,
  sequenceNumber: number,
  eventData: Record<string, unknown> = { message: "hello" },
  timestamp = "2026-01-15T10:30:00Z",
): Record<string, unknown> {
  return {
    _time: timestamp,
    runId,
    userId: "test-user",
    sequenceNumber,
    eventType: "assistant",
    eventData,
  };
}

interface RunFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly runId: string;
}

async function rawRequest(
  path: string,
  authorization = "Bearer clerk-session",
): Promise<{ status: number; body: unknown }> {
  const app = createApp({ signal: context.signal, routes: ROUTES });
  const response = await app.request(path, {
    method: "GET",
    headers: { authorization },
  });
  const text = await response.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : undefined;
  return { status: response.status, body };
}

describe("GET /api/agent/runs/:id telemetry routes", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  async function setupRun(
    args: {
      readonly status?: string;
      readonly result?: Record<string, unknown>;
      readonly error?: string;
      readonly lastEventSequence?: number;
      readonly composeContent?: unknown;
    } = {},
  ): Promise<RunFixture> {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      fixture,
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        ...fixture,
        composeId,
        status: args.status,
        result: args.result,
        error: args.error,
        lastEventSequence: args.lastEventSequence,
      },
      context.signal,
    );
    if (args.composeContent !== undefined) {
      const db = store.set(writeDb$);
      await db
        .update(agentComposeVersions)
        .set({ content: args.composeContent })
        .where(eq(agentComposeVersions.composeId, composeId));
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    return {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId,
      runId,
    };
  }

  async function insertTelemetry(
    runId: string,
    data: {
      readonly systemLog?: string;
      readonly metrics?: readonly {
        readonly ts: string;
        readonly cpu: number;
        readonly mem_used: number;
        readonly mem_total: number;
        readonly disk_used: number;
        readonly disk_total: number;
      }[];
    },
  ): Promise<void> {
    const db = store.set(writeDb$);
    await db.insert(sandboxTelemetry).values({ runId, data });
  }

  it("returns 401 when the events request is unauthenticated", async () => {
    const client = setupApp({ context })(runEventsContract);

    const response = await accept(
      client.getEvents({
        params: { id: randomUUID() },
        query: {},
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    const response = await rawRequest(
      `/api/agent/runs/${randomUUID()}/telemetry`,
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("returns 404 for another user's run without leaking existence", async () => {
    const owner = await setupRun();
    const other = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(other.userId, other.orgId);

    const client = setupApp({ context })(runEventsContract);
    const response = await accept(
      client.getEvents({
        params: { id: owner.runId },
        query: {},
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });

  it("accepts sandbox tokens on read endpoints without requiring a Zero capability", async () => {
    context.mocks.axiom.query.mockResolvedValueOnce([]);
    const fixture = await setupRun();
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: fixture.runId,
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context })(runAgentEventsContract);
    const response = await accept(
      client.getAgentEvents({
        params: { id: fixture.runId },
        query: {},
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      events: [],
      hasMore: false,
      framework: "claude-code",
    });
  });

  it("returns events with run state, framework, gap filtering, and noCache after watermark wait", async () => {
    context.mocks.axiom.query.mockResolvedValueOnce([
      { sequenceNumber: 0 },
      { sequenceNumber: 1 },
    ]);
    const result = {
      checkpointId: randomUUID(),
      agentSessionId: randomUUID(),
      conversationId: randomUUID(),
    };
    const fixture = await setupRun({
      status: "completed",
      result,
      lastEventSequence: 1,
      composeContent: { agent: { framework: "codex" } },
    });
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(
        fixture.runId,
        0,
        { type: "assistant", text: "first" },
        "2026-01-15T10:30:00Z",
      ),
      makeAxiomEvent(
        fixture.runId,
        2,
        { type: "assistant", text: "gap" },
        "2026-01-15T10:30:02Z",
      ),
    ]);

    const client = setupApp({ context })(runEventsContract);
    const response = await accept(
      client.getEvents({
        params: { id: fixture.runId },
        query: { since: -1, limit: 10 },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.events).toStrictEqual([
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: { type: "assistant", text: "first" },
        createdAt: "2026-01-15T10:30:00Z",
      },
    ]);
    expect(response.body.hasMore).toBeTruthy();
    expect(response.body.nextSequence).toBe(0);
    expect(response.body.framework).toBe("codex");
    expect(response.body.run).toStrictEqual({
      status: "completed",
      result,
      lastEventSequence: 1,
    });
    expect(context.mocks.axiom.query).toHaveBeenCalledTimes(2);
    expect(context.mocks.axiom.query.mock.calls[0]?.[0]).toContain(
      "project sequenceNumber",
    );
    expect(context.mocks.axiom.query.mock.calls[0]?.[1]).toStrictEqual({
      noCache: true,
    });
    expect(context.mocks.axiom.query.mock.calls[1]?.[0]).toContain(
      `runId == "${fixture.runId}"`,
    );
    expect(context.mocks.axiom.query.mock.calls[1]?.[1]).toStrictEqual({
      noCache: true,
    });
  });

  it("aggregates legacy telemetry records from Postgres", async () => {
    const fixture = await setupRun();
    await insertTelemetry(fixture.runId, {
      systemLog: "boot\n",
      metrics: [
        {
          ts: "2026-01-15T10:30:00Z",
          cpu: 0.1,
          mem_used: 10,
          mem_total: 100,
          disk_used: 20,
          disk_total: 200,
        },
      ],
    });
    await insertTelemetry(fixture.runId, {
      systemLog: "ready\n",
      metrics: [
        {
          ts: "2026-01-15T10:31:00Z",
          cpu: 0.2,
          mem_used: 11,
          mem_total: 100,
          disk_used: 21,
          disk_total: 200,
        },
      ],
    });

    const client = setupApp({ context })(runTelemetryContract);
    const response = await accept(
      client.getTelemetry({
        params: { id: fixture.runId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.systemLog).toBe("boot\nready\n");
    expect(response.body.metrics).toHaveLength(2);
    expect(response.body.metrics[1]?.cpu).toBe(0.2);
  });

  it("returns empty legacy telemetry when no Postgres records exist", async () => {
    const fixture = await setupRun();

    const client = setupApp({ context })(runTelemetryContract);
    const response = await accept(
      client.getTelemetry({
        params: { id: fixture.runId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      systemLog: "",
      metrics: [],
    });
  });

  it("returns paged agent telemetry events from Axiom", async () => {
    const fixture = await setupRun();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(fixture.runId, 1, { message: "one" }),
      makeAxiomEvent(fixture.runId, 2, { message: "two" }),
      makeAxiomEvent(fixture.runId, 3, { message: "three" }),
    ]);

    const client = setupApp({ context })(runAgentEventsContract);
    const response = await accept(
      client.getAgentEvents({
        params: { id: fixture.runId },
        query: { limit: 2, order: "asc", since: 0 },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.events).toHaveLength(2);
    expect(response.body.events[0]?.sequenceNumber).toBe(1);
    expect(response.body.hasMore).toBeTruthy();
    const apl = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(apl).toContain("| where sequenceNumber > 0");
    expect(apl).toContain("| order by sequenceNumber asc");
  });

  it("returns system log pages from Axiom", async () => {
    const fixture = await setupRun();
    const since = Date.parse("2026-01-15T10:29:00Z");
    context.mocks.axiom.query.mockResolvedValueOnce([
      { _time: "2026-01-15T10:30:00Z", runId: fixture.runId, log: "a\n" },
      { _time: "2026-01-15T10:31:00Z", runId: fixture.runId, log: "b\n" },
    ]);

    const client = setupApp({ context })(runSystemLogContract);
    const response = await accept(
      client.getSystemLog({
        params: { id: fixture.runId },
        query: { limit: 1, order: "asc", since },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      systemLog: "a\n",
      hasMore: true,
    });
    const apl = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(apl).toContain("sandbox-telemetry-system");
    expect(apl).toContain(new Date(since).toISOString());
    expect(apl).toContain("| order by _time asc");
  });

  it("returns empty system log pages when Axiom has no records", async () => {
    const fixture = await setupRun();
    context.mocks.axiom.query.mockResolvedValueOnce([]);

    const client = setupApp({ context })(runSystemLogContract);
    const response = await accept(
      client.getSystemLog({
        params: { id: fixture.runId },
        query: { limit: 10, order: "desc" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      systemLog: "",
      hasMore: false,
    });
  });

  it("returns 404 for another user's system log without leaking existence", async () => {
    const owner = await setupRun();
    const other = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(other.userId, other.orgId);

    const client = setupApp({ context })(runSystemLogContract);
    const response = await accept(
      client.getSystemLog({
        params: { id: owner.runId },
        query: {},
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });

  it("returns 400 for invalid system log query parameters", async () => {
    const fixture = await setupRun();

    const response = await rawRequest(
      `/api/agent/runs/${fixture.runId}/telemetry/system-log?limit=101`,
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("returns metric pages from Axiom", async () => {
    const fixture = await setupRun();
    context.mocks.axiom.query.mockResolvedValueOnce([
      {
        _time: "2026-01-15T10:30:00Z",
        runId: fixture.runId,
        userId: fixture.userId,
        cpu: 0.4,
        mem_used: 40,
        mem_total: 100,
        disk_used: 50,
        disk_total: 200,
      },
      {
        _time: "2026-01-15T10:31:00Z",
        runId: fixture.runId,
        userId: fixture.userId,
        cpu: 0.5,
        mem_used: 41,
        mem_total: 100,
        disk_used: 51,
        disk_total: 200,
      },
    ]);

    const client = setupApp({ context })(runMetricsContract);
    const since = Date.parse("2026-01-15T10:29:00Z");
    const response = await accept(
      client.getMetrics({
        params: { id: fixture.runId },
        query: { limit: 1, order: "desc", since },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      metrics: [
        {
          ts: "2026-01-15T10:30:00Z",
          cpu: 0.4,
          mem_used: 40,
          mem_total: 100,
          disk_used: 50,
          disk_total: 200,
        },
      ],
      hasMore: true,
    });
    const apl = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(apl).toContain("sandbox-telemetry-metrics");
    expect(apl).toContain(new Date(since).toISOString());
    expect(apl).toContain("| order by _time desc");
  });

  it("returns network log pages with capture and firewall fields from Axiom", async () => {
    const fixture = await setupRun();
    context.mocks.axiom.query.mockResolvedValueOnce([
      {
        _time: "2026-01-15T10:30:00Z",
        runId: fixture.runId,
        userId: fixture.userId,
        type: "http",
        action: "ALLOW",
        host: "example.com",
        port: 443,
        method: "GET",
        url: "https://example.com/",
        status: 200,
        latency_ms: 12,
        request_size: 10,
        response_size: 20,
        dns_event: "resolve",
        dns_query_type: "A",
        dns_result: "1.2.3.4",
        dns_serial: "dns-1",
        firewall_base: "base",
        firewall_name: "net",
        firewall_permission: "github:read",
        firewall_rule_match: "allow",
        firewall_params: { owner: "vm0-ai" },
        firewall_billable: true,
        firewall_error: "none",
        auth_resolved_secrets: ["TOKEN"],
        auth_refreshed_connectors: ["github"],
        auth_refreshed_secrets: ["TOKEN"],
        auth_cache_hit: false,
        auth_url_rewrite: true,
        request_body: "abc",
        request_body_encoding: "base64",
        request_body_truncated: false,
        response_body: "def",
        response_body_encoding: "base64",
        response_body_truncated: false,
      },
    ]);

    const client = setupApp({ context })(runNetworkLogsContract);
    const since = Date.parse("2026-01-15T10:29:00Z");
    const response = await accept(
      client.getNetworkLogs({
        params: { id: fixture.runId },
        query: { limit: 10, order: "desc", since },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.networkLogs).toHaveLength(1);
    expect(response.body.networkLogs[0]).toMatchObject({
      timestamp: "2026-01-15T10:30:00Z",
      action: "ALLOW",
      host: "example.com",
      dns_result: "1.2.3.4",
      firewall_params: { owner: "vm0-ai" },
      request_body: "abc",
      response_body: "def",
    });
    expect(response.body.hasMore).toBeFalsy();
    const apl = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(apl).toContain("sandbox-telemetry-network");
    expect(apl).toContain(new Date(since).toISOString());
    expect(apl).toContain("| order by _time desc");
  });

  it("omits null optional network log fields from Axiom", async () => {
    const fixture = await setupRun();
    context.mocks.axiom.query.mockResolvedValueOnce([
      {
        _time: "2026-01-15T10:30:00Z",
        runId: fixture.runId,
        userId: fixture.userId,
        type: "tcp",
        action: null,
        host: null,
        port: 0,
        method: null,
        url: null,
        status: 0,
        latency_ms: 0,
        request_size: null,
        response_size: null,
        dns_event: null,
        dns_query_type: null,
        dns_result: null,
        dns_serial: null,
        firewall_base: null,
        firewall_name: null,
        firewall_permission: null,
        firewall_rule_match: null,
        firewall_params: { owner: "vm0-ai", empty: null },
        firewall_billable: false,
        firewall_error: null,
        auth_resolved_secrets: null,
        auth_refreshed_connectors: null,
        auth_refreshed_secrets: null,
        auth_cache_hit: false,
        auth_url_rewrite: false,
        error: null,
        request_headers: { host: "example.com", authorization: null },
        request_body: null,
        request_body_encoding: null,
        request_body_truncated: false,
        response_headers: { server: "test", date: null },
        response_body: null,
        response_body_encoding: null,
        response_body_truncated: false,
      },
    ]);

    const client = setupApp({ context })(runNetworkLogsContract);
    const response = await accept(
      client.getNetworkLogs({
        params: { id: fixture.runId },
        query: { limit: 10, order: "desc" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.networkLogs).toStrictEqual([
      {
        timestamp: "2026-01-15T10:30:00Z",
        type: "tcp",
        port: 0,
        status: 0,
        latency_ms: 0,
        firewall_params: { owner: "vm0-ai" },
        firewall_billable: false,
        auth_cache_hit: false,
        auth_url_rewrite: false,
        request_headers: { host: "example.com" },
        request_body_truncated: false,
        response_headers: { server: "test" },
        response_body_truncated: false,
      },
    ]);
  });

  it("returns 400 for invalid telemetry query parameters", async () => {
    const fixture = await setupRun();

    const response = await rawRequest(
      `/api/agent/runs/${fixture.runId}/telemetry/metrics?limit=101`,
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });
});
