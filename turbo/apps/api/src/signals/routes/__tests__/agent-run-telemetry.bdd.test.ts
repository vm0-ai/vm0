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

// BDD migration of the legacy `agent-run-telemetry.test.ts`.
// The 16 legacy `it()`s collapse into 5 BDD `it()`s covering
// the 5 telemetry read endpoints (events, agent events,
// telemetry aggregate, system log, metrics, network logs):
// (1) auth + 404 cross-user chain (401 events → 400 no-org →
// 404 other user's events + 404 other user's system log),
// (2) events + agent events chain (sandbox events 200 →
// events 200 with run-state + framework + gap-filter + noCache
// → agent events paged from axiom),
// (3) telemetry aggregate + 400 chain (200 aggregated system
// log + metrics from Postgres → 200 empty when no records →
// 400 invalid system log + 400 invalid metrics),
// (4) system log + metrics chain (200 system log paged from
// Axiom → 200 empty system log),
// (5) network logs chain (200 with capture + firewall fields
// → 200 omitting null optional fields).
//
// The legacy "axiom.query was called with this APL" assertions
// are surfaced through `context.mocks.axiom.query.mock.calls`
// (Axiom is a mocked external service per the BDD plan, so
// verifying the generated APL through the mock is faithful).
// The legacy `sandboxTelemetry` direct-DB inserts are
// inlined as `insertTelemetry$` (Open Helper Gap — the public
// API does not expose a "write legacy telemetry for a run"
// primitive).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
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

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

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
  const { composeId } = await store.set(seedCompose$, fixture, context.signal);
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

describe("BDD GET /api/agent/runs/:id telemetry — auth + 404 cross-user chain", () => {
  it("gwt-wt-wt: 401 events unauth → 400 no-org → 404 other-user events → 404 other-user system log", async () => {
    // When + Then: 401 events.
    const events401 = await accept(
      setupApp({ context })(runEventsContract).getEvents({
        params: { id: randomUUID() },
        query: {},
        headers: {},
      }),
      [401],
    );
    expect(events401.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: an authenticated session with no active org.
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    // When + Then: 400 — no org.
    const noOrg = await rawRequest(`/api/agent/runs/${randomUUID()}/telemetry`);
    expect(noOrg.status).toBe(400);
    expect(noOrg.body).toMatchObject({ error: { code: "BAD_REQUEST" } });

    // Given: a run owned by another org + a session in yet
    // another org.
    const owner = await setupRun();
    const other = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(other.userId, other.orgId);

    // When + Then: 404 events.
    const crossUserEvents = await accept(
      setupApp({ context })(runEventsContract).getEvents({
        params: { id: owner.runId },
        query: {},
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUserEvents.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });

    // When + Then: 404 system log.
    const crossUserSystemLog = await accept(
      setupApp({ context })(runSystemLogContract).getSystemLog({
        params: { id: owner.runId },
        query: {},
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUserSystemLog.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });
});

describe("BDD GET /api/agent/runs/:id telemetry — events + agent events chain", () => {
  it("gwt-wt-wt: 200 sandbox agent events → 200 events with run-state + framework + gap-filter + noCache → 200 agent events paged from axiom", async () => {
    // Given: a run + a sandbox token.
    context.mocks.axiom.query.mockResolvedValueOnce([]);
    const fixture = await setupRun();
    const seconds = currentSecond();
    const sandboxToken = signSandboxJwtForTests({
      scope: "sandbox",
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: fixture.runId,
      iat: seconds,
      exp: seconds + 600,
    });

    // When + Then: 200 — sandbox agent events returns empty.
    const sandboxAgent = await accept(
      setupApp({ context })(runAgentEventsContract).getAgentEvents({
        params: { id: fixture.runId },
        query: {},
        headers: { authorization: `Bearer ${sandboxToken}` },
      }),
      [200],
    );
    expect(sandboxAgent.body).toStrictEqual({
      events: [],
      hasMore: false,
      framework: "claude-code",
    });

    // Given: a completed run with a `lastEventSequence` + a
    // custom compose framework `codex`. The events call
    // resolves the watermark first, then returns the events.
    context.mocks.axiom.query.mockReset();
    context.mocks.axiom.query.mockResolvedValueOnce([
      { sequenceNumber: 0 },
      { sequenceNumber: 1 },
    ]);
    const result = {
      checkpointId: randomUUID(),
      agentSessionId: randomUUID(),
      conversationId: randomUUID(),
    };
    const eventsFixture = await setupRun({
      status: "completed",
      result,
      lastEventSequence: 1,
      composeContent: { agent: { framework: "codex" } },
    });
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(
        eventsFixture.runId,
        0,
        { type: "assistant", text: "first" },
        "2026-01-15T10:30:00Z",
      ),
      makeAxiomEvent(
        eventsFixture.runId,
        2,
        { type: "assistant", text: "gap" },
        "2026-01-15T10:30:02Z",
      ),
    ]);

    // When + Then: 200 — gap-filter drops the second event
    // (sequence 2 > lastEventSequence 1), and the run-state
    // + framework are surfaced.
    const events = await accept(
      setupApp({ context })(runEventsContract).getEvents({
        params: { id: eventsFixture.runId },
        query: { since: -1, limit: 10 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(events.body.events).toStrictEqual([
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: { type: "assistant", text: "first" },
        createdAt: "2026-01-15T10:30:00Z",
      },
    ]);
    expect(events.body.hasMore).toBeTruthy();
    expect(events.body.nextSequence).toBe(0);
    expect(events.body.framework).toBe("codex");
    expect(events.body.run).toStrictEqual({
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
      `runId == "${eventsFixture.runId}"`,
    );
    expect(context.mocks.axiom.query.mock.calls[1]?.[1]).toStrictEqual({
      noCache: true,
    });

    // Given: an empty axiom page for agent events.
    context.mocks.axiom.query.mockReset();
    const agentFixture = await setupRun();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(agentFixture.runId, 1, { message: "one" }),
      makeAxiomEvent(agentFixture.runId, 2, { message: "two" }),
      makeAxiomEvent(agentFixture.runId, 3, { message: "three" }),
    ]);

    // When + Then: 200 — 2 events returned, the APL includes
    // the `where sequenceNumber > 0` filter and the
    // `order by sequenceNumber asc` clause.
    const agentEvents = await accept(
      setupApp({ context })(runAgentEventsContract).getAgentEvents({
        params: { id: agentFixture.runId },
        query: { limit: 2, order: "asc", since: 0 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(agentEvents.body.events).toHaveLength(2);
    expect(agentEvents.body.events[0]?.sequenceNumber).toBe(1);
    expect(agentEvents.body.hasMore).toBeTruthy();
    const apl = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(apl).toContain("| where sequenceNumber > 0");
    expect(apl).toContain("| order by sequenceNumber asc");
  });
});

describe("BDD GET /api/agent/runs/:id telemetry — aggregate + 400 chain", () => {
  it("gwt-wt-wt: 200 aggregated system log + metrics from Postgres → 200 empty → 400 invalid system log → 400 invalid metrics", async () => {
    // Given: a run with two sandbox telemetry rows
    // (concatenated system log + two metric samples).
    const aggregateFixture = await setupRun();
    await insertTelemetry(aggregateFixture.runId, {
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
    await insertTelemetry(aggregateFixture.runId, {
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

    // When + Then: 200 — systemLog is concatenated and
    // metrics include both samples in order.
    const aggregate = await accept(
      setupApp({ context })(runTelemetryContract).getTelemetry({
        params: { id: aggregateFixture.runId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(aggregate.body.systemLog).toBe("boot\nready\n");
    expect(aggregate.body.metrics).toHaveLength(2);
    expect(aggregate.body.metrics[1]?.cpu).toBe(0.2);

    // Given: a fresh run with no telemetry rows.
    const emptyFixture = await setupRun();

    // When + Then: 200 with empty defaults.
    const empty = await accept(
      setupApp({ context })(runTelemetryContract).getTelemetry({
        params: { id: emptyFixture.runId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(empty.body).toStrictEqual({ systemLog: "", metrics: [] });

    // Given: the empty fixture's runId.
    // When + Then: 400 — invalid system log query (limit 101).
    const badSystemLog = await rawRequest(
      `/api/agent/runs/${emptyFixture.runId}/telemetry/system-log?limit=101`,
    );
    expect(badSystemLog.status).toBe(400);
    expect(badSystemLog.body).toMatchObject({ error: { code: "BAD_REQUEST" } });

    // When + Then: 400 — invalid metrics query (limit 101).
    const badMetrics = await rawRequest(
      `/api/agent/runs/${emptyFixture.runId}/telemetry/metrics?limit=101`,
    );
    expect(badMetrics.status).toBe(400);
    expect(badMetrics.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });
});

describe("BDD GET /api/agent/runs/:id telemetry — system log + metrics chain", () => {
  it("gwt-wt-wt: 200 system log paged from Axiom → 200 empty system log → 200 metrics paged from Axiom", async () => {
    // Given: a run + a 2-row axiom response for the system log.
    const systemLogFixture = await setupRun();
    const since = Date.parse("2026-01-15T10:29:00Z");
    context.mocks.axiom.query.mockResolvedValueOnce([
      {
        _time: "2026-01-15T10:30:00Z",
        runId: systemLogFixture.runId,
        log: "a\n",
      },
      {
        _time: "2026-01-15T10:31:00Z",
        runId: systemLogFixture.runId,
        log: "b\n",
      },
    ]);

    // When + Then: 200 — limit 1 returns the first row.
    const systemLog = await accept(
      setupApp({ context })(runSystemLogContract).getSystemLog({
        params: { id: systemLogFixture.runId },
        query: { limit: 1, order: "asc", since },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(systemLog.body).toStrictEqual({
      systemLog: "a\n",
      hasMore: true,
    });
    const systemLogApl = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(systemLogApl).toContain("sandbox-telemetry-system");
    expect(systemLogApl).toContain(new Date(since).toISOString());
    expect(systemLogApl).toContain("| order by _time asc");

    // Given: a run + an empty axiom page.
    context.mocks.axiom.query.mockReset();
    const emptyFixture = await setupRun();
    context.mocks.axiom.query.mockResolvedValueOnce([]);

    // When + Then: 200 — empty.
    const empty = await accept(
      setupApp({ context })(runSystemLogContract).getSystemLog({
        params: { id: emptyFixture.runId },
        query: { limit: 10, order: "desc" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(empty.body).toStrictEqual({ systemLog: "", hasMore: false });

    // Given: a run + a 2-row axiom response for the metrics.
    context.mocks.axiom.query.mockReset();
    const metricsFixture = await setupRun();
    context.mocks.axiom.query.mockResolvedValueOnce([
      {
        _time: "2026-01-15T10:30:00Z",
        runId: metricsFixture.runId,
        userId: metricsFixture.userId,
        cpu: 0.4,
        mem_used: 40,
        mem_total: 100,
        disk_used: 50,
        disk_total: 200,
      },
      {
        _time: "2026-01-15T10:31:00Z",
        runId: metricsFixture.runId,
        userId: metricsFixture.userId,
        cpu: 0.5,
        mem_used: 41,
        mem_total: 100,
        disk_used: 51,
        disk_total: 200,
      },
    ]);

    // When + Then: 200 — limit 1 returns the first row + the
    // APL is built from `sandbox-telemetry-metrics` with
    // `order by _time desc`.
    const metrics = await accept(
      setupApp({ context })(runMetricsContract).getMetrics({
        params: { id: metricsFixture.runId },
        query: { limit: 1, order: "desc", since },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(metrics.body).toStrictEqual({
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
    const metricsApl = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(metricsApl).toContain("sandbox-telemetry-metrics");
    expect(metricsApl).toContain(new Date(since).toISOString());
    expect(metricsApl).toContain("| order by _time desc");
  });
});

describe("BDD GET /api/agent/runs/:id telemetry — network logs chain", () => {
  it("gwt-wt-wt: 200 with capture + firewall fields → 200 omitting null optional fields", async () => {
    // Given: a run + a 1-row axiom response with the full
    // network log shape (capture + firewall fields populated).
    const captureFixture = await setupRun();
    context.mocks.axiom.query.mockResolvedValueOnce([
      {
        _time: "2026-01-15T10:30:00Z",
        runId: captureFixture.runId,
        userId: captureFixture.userId,
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
        browser_user_agent: true,
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
    const captureSince = Date.parse("2026-01-15T10:29:00Z");

    // When + Then: 200 — the network log entry exposes the
    // capture + firewall fields, and the APL is built from
    // `sandbox-telemetry-network` with `order by _time desc`.
    const capture = await accept(
      setupApp({ context })(runNetworkLogsContract).getNetworkLogs({
        params: { id: captureFixture.runId },
        query: { limit: 10, order: "desc", since: captureSince },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(capture.body.networkLogs).toHaveLength(1);
    expect(capture.body.networkLogs[0]).toMatchObject({
      timestamp: "2026-01-15T10:30:00Z",
      action: "ALLOW",
      host: "example.com",
      browser_user_agent: true,
      dns_result: "1.2.3.4",
      firewall_params: { owner: "vm0-ai" },
      request_body: "abc",
      response_body: "def",
    });
    expect(capture.body.hasMore).toBeFalsy();
    const captureApl = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(captureApl).toContain("sandbox-telemetry-network");
    expect(captureApl).toContain(new Date(captureSince).toISOString());
    expect(captureApl).toContain("| order by _time desc");

    // Given: a run + a 1-row axiom response with most fields
    // null. The response should drop the null optional fields.
    context.mocks.axiom.query.mockReset();
    const omitFixture = await setupRun();
    context.mocks.axiom.query.mockResolvedValueOnce([
      {
        _time: "2026-01-15T10:30:00Z",
        runId: omitFixture.runId,
        userId: omitFixture.userId,
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
        browser_user_agent: null,
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

    // When + Then: 200 — null optional fields are omitted.
    const omitted = await accept(
      setupApp({ context })(runNetworkLogsContract).getNetworkLogs({
        params: { id: omitFixture.runId },
        query: { limit: 10, order: "desc" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(omitted.body.networkLogs).toStrictEqual([
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
});
