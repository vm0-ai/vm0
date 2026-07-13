import { randomUUID } from "node:crypto";

import { cronAggregateUsageContract } from "@vm0/api-contracts/contracts/cron";
import { usageContract } from "@vm0/api-contracts/contracts/usage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createZeroRouteMocks(context);

/*
 * This file owns valid aggregate-usage cron coverage. The fixed clock keeps
 * its previous-day global sweep outside wall-clock windows used by parallel
 * test files, while unique actors keep user-visible assertions isolated.
 */
const FIXED_NOW_ISO = "2026-05-12T12:00:00.000Z";

interface UsageActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
}

interface CompletedRunArgs {
  readonly createdAt: Date;
  readonly durationMs: number;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(usageContract);
}

function aggregateUsageClient() {
  return setupApp({ context })(cronAggregateUsageContract);
}

async function entitledUsageActor(): Promise<UsageActor> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Usage summary agent",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup };
}

/**
 * Drives a run through its production lifecycle at a mocked clock. Creation
 * happens at `createdAt`, while runner claim time comes from PostgreSQL. The
 * sandbox completion clock is aligned to the persisted claim time plus
 * `durationMs`. The failure path terminates the run without checkpoint
 * plumbing; /api/usage aggregates every finished run.
 */
async function runFinishedRun(
  fixture: UsageActor,
  args: CompletedRunArgs,
): Promise<string> {
  mockNow(args.createdAt);
  const run = await api.createRun(fixture.actor, {
    agentId: fixture.agentId,
    prompt: "usage summary run",
    modelProvider: "anthropic-api-key",
  });
  await api.heartbeatRunner(fixture.runnerGroup);
  await api.claimRunnerJob(run.runId);
  const running = await api.readRun(fixture.actor, run.runId);
  if (!running.startedAt) {
    throw new Error("Claimed usage run is missing startedAt");
  }
  mockNow(new Date(new Date(running.startedAt).getTime() + args.durationMs));
  const sandboxToken = api.sandboxTokenForRun(fixture.actor, run.runId);
  await webhooks.requestAgentComplete(
    { runId: run.runId, exitCode: 1, error: "bdd usage summary run" },
    { authorization: `Bearer ${sandboxToken}` },
    [200],
  );
  mockNow(new Date(FIXED_NOW_ISO));
  return run.runId;
}

describe("GET /api/usage", () => {
  beforeEach(() => {
    mockNow(new Date(FIXED_NOW_ISO));
  });

  afterEach(() => {
    clearMockNow();
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      apiClient().get({ query: {}, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns usage data with the default 7 day range", async () => {
    const fixture = await entitledUsageActor();
    await runFinishedRun(fixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 60_000,
    });
    await runFinishedRun(fixture, {
      createdAt: new Date("2026-05-12T11:00:00.000Z"),
      durationMs: 120_000,
    });
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.period).toStrictEqual({
      start: "2026-05-05T12:00:00.000Z",
      end: "2026-05-12T12:00:00.000Z",
    });
    expect(response.body.summary).toStrictEqual({
      total_runs: 2,
      total_run_time_ms: 180_000,
    });
    expect(response.body.daily).toHaveLength(1);
    expect(response.body.daily[0]).toStrictEqual({
      date: "2026-05-12",
      run_count: 2,
      run_time_ms: 180_000,
    });
  });

  it("accepts a custom date range", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        query: {
          start_date: "2026-05-09T12:00:00.000Z",
          end_date: "2026-05-12T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.period).toStrictEqual({
      start: "2026-05-09T12:00:00.000Z",
      end: "2026-05-12T12:00:00.000Z",
    });
  });

  it("treats empty date query parameters as the default range", async () => {
    const fixture = await entitledUsageActor();
    await runFinishedRun(fixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 60_000,
    });
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const response = await accept(
      apiClient().get({
        query: { start_date: "", end_date: "" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.period).toStrictEqual({
      start: "2026-05-05T12:00:00.000Z",
      end: "2026-05-12T12:00:00.000Z",
    });
    expect(response.body.summary).toStrictEqual({
      total_runs: 1,
      total_run_time_ms: 60_000,
    });
  });

  it("rejects invalid start_date format", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        query: { start_date: "invalid" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.message).toContain("Invalid start_date format");
  });

  it("rejects invalid end_date format", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        query: { end_date: "invalid" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.message).toContain("Invalid end_date format");
  });

  it("rejects start_date after end_date", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        query: {
          start_date: "2026-05-12T12:00:00.000Z",
          end_date: "2026-05-11T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "start_date must be before end_date",
    );
  });

  it("rejects ranges exceeding 30 days", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        query: {
          start_date: "2026-04-01T12:00:00.000Z",
          end_date: "2026-05-12T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "Time range exceeds maximum of 30 days",
    );
  });

  it("returns daily breakdown rows and summary totals", async () => {
    const fixture = await entitledUsageActor();
    await runFinishedRun(fixture, {
      createdAt: new Date("2026-05-12T09:00:00.000Z"),
      durationMs: 45_000,
    });
    await runFinishedRun(fixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 15_000,
    });
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.summary.total_runs).toBe(2);
    expect(response.body.summary.total_run_time_ms).toBe(60_000);
    for (const day of response.body.daily) {
      expect(typeof day.date).toBe("string");
      expect(typeof day.run_count).toBe("number");
      expect(typeof day.run_time_ms).toBe("number");
    }
  });

  it("calculates run times from claim to completion", async () => {
    const fixture = await entitledUsageActor();
    await runFinishedRun(fixture, {
      createdAt: new Date("2026-05-12T09:00:00.000Z"),
      durationMs: 60_000,
    });
    await runFinishedRun(fixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 120_000,
    });
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.summary.total_runs).toBe(2);
    expect(response.body.summary.total_run_time_ms).toBe(180_000);
  });

  it("aggregates historical runs across multiple days", async () => {
    const fixture = await entitledUsageActor();
    await runFinishedRun(fixture, {
      createdAt: new Date("2026-05-08T10:00:00.000Z"),
      durationMs: 5000,
    });
    await runFinishedRun(fixture, {
      createdAt: new Date("2026-05-09T10:00:00.000Z"),
      durationMs: 8000,
    });
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const response = await accept(
      apiClient().get({
        query: {
          start_date: "2026-05-07T00:00:00.000Z",
          end_date: "2026-05-12T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.summary).toStrictEqual({
      total_runs: 2,
      total_run_time_ms: 13_000,
    });
    expect(response.body.daily).toStrictEqual([
      { date: "2026-05-09", run_count: 1, run_time_ms: 8000 },
      { date: "2026-05-08", run_count: 1, run_time_ms: 5000 },
    ]);
  });

  it("uses agent_runs for partial start day boundaries", async () => {
    const fixture = await entitledUsageActor();
    await runFinishedRun(fixture, {
      createdAt: new Date("2026-05-10T08:00:00.000Z"),
      durationMs: 3000,
    });
    await runFinishedRun(fixture, {
      createdAt: new Date("2026-05-10T14:00:00.000Z"),
      durationMs: 5000,
    });
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const response = await accept(
      apiClient().get({
        query: {
          start_date: "2026-05-10T14:00:00.000Z",
          end_date: "2026-05-12T12:00:00.000Z",
        },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.daily).toStrictEqual([
      { date: "2026-05-10", run_count: 1, run_time_ms: 5000 },
    ]);
  });

  it("caches computed historical results for subsequent queries", async () => {
    const fixture = await entitledUsageActor();
    await runFinishedRun(fixture, {
      createdAt: new Date("2026-05-08T10:00:00.000Z"),
      durationMs: 6000,
    });
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const request = {
      query: {
        start_date: "2026-05-07T00:00:00.000Z",
        end_date: "2026-05-12T12:00:00.000Z",
      },
      headers: authHeaders(),
    };

    const first = await accept(apiClient().get(request), [200]);
    expect(first.body.summary.total_runs).toBe(1);
    expect(first.body.summary.total_run_time_ms).toBe(6000);

    const second = await accept(apiClient().get(request), [200]);
    expect(second.body.summary).toStrictEqual(first.body.summary);
    expect(second.body.daily).toStrictEqual(first.body.daily);
  });

  it("only returns usage for the authenticated org", async () => {
    const fixture = await entitledUsageActor();
    const otherFixture = await entitledUsageActor();
    await runFinishedRun(fixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 5000,
    });
    await runFinishedRun(otherFixture, {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      durationMs: 8000,
    });
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.summary).toStrictEqual({
      total_runs: 1,
      total_run_time_ms: 5000,
    });
  });
});

describe("GET /api/cron/aggregate-usage", () => {
  beforeEach(() => {
    mockNow(new Date(FIXED_NOW_ISO));
  });

  afterEach(() => {
    clearMockNow();
  });

  it("aggregates the previous day's completed runs", async () => {
    const fixture = await entitledUsageActor();
    await runFinishedRun(fixture, {
      createdAt: new Date("2026-05-11T10:00:00.000Z"),
      durationMs: 5000,
    });

    const response = await accept(
      aggregateUsageClient().aggregate({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );

    expect(response.body.date).toBe("2026-05-11");
    expect(response.body.aggregated).toBeGreaterThan(0);
  });
});
