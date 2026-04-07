import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createCompletedTestRun,
  ensureOrgRow,
  findInsightsDaily,
  seedCreditUsageRecord,
  seedUserCacheEntry,
} from "../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../src/env";

vi.hoisted(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
});

const context = testContext();

function cronRequest(secret?: string) {
  return new Request("http://localhost:3000/api/cron/aggregate-insights", {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

/**
 * Returns a recent timestamp within today's UTC window.
 * The cron aggregates runs from today's local-day start to now,
 * so test runs must fall within this window.
 */
function recentDate(): { date: Date; dateStr: string } {
  const now = new Date();
  const date = new Date(now.getTime() - 60_000); // 1 minute ago
  return { date, dateStr: todayDateStr() };
}

/** The cron stores insights under today's date (the current local date). */
function todayDateStr(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
    .toISOString()
    .split("T")[0]!;
}

describe("GET /api/cron/aggregate-insights", () => {
  let composeVersionId: string;
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    reloadEnv();
    const user = await context.setupUser();
    userId = user.userId;
    orgId = user.orgId;
    const { versionId } = await createTestCompose(uniqueId("insights-agent"));
    composeVersionId = versionId;

    // Ensure org has metadata row for credit balance lookup
    await ensureOrgRow(orgId);
  });

  it("should return 401 with invalid cron secret", async () => {
    const response = await GET(cronRequest("wrong-secret"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 401 with missing authorization header", async () => {
    const response = await GET(cronRequest());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 200 with no runs for this org", async () => {
    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);

    // This org had no runs, so no insights row should exist
    const row = await findInsightsDaily(orgId, todayDateStr(), userId);
    expect(row).toBeUndefined();
  });

  it("should aggregate previous day agent runs", async () => {
    const { date, dateStr } = recentDate();

    await createCompletedTestRun({
      composeVersionId,
      userId,
      createdAt: date,
      startedAt: date,
      completedAt: new Date(date.getTime() + 5000),
    });

    // Second run
    const run2Start = new Date(date.getTime() + 60000);
    await createCompletedTestRun({
      composeVersionId,
      userId,
      createdAt: run2Start,
      startedAt: run2Start,
      completedAt: new Date(run2Start.getTime() + 8000),
    });

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const row = await findInsightsDaily(orgId, todayDateStr(), userId);
    expect(row).toBeDefined();

    const data = row!.data;
    const agents = data.agents as Array<{
      agentName: string;
      runs: number;
      credits: number;
    }>;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.runs).toBe(2);
  });

  it("should aggregate credit usage per member", async () => {
    const { date, dateStr } = recentDate();

    const runId = await createCompletedTestRun({
      composeVersionId,
      userId,
      createdAt: date,
      startedAt: date,
      completedAt: new Date(date.getTime() + 5000),
    });

    await seedUserCacheEntry(userId, "test@example.com");

    await seedCreditUsageRecord({
      runId,
      orgId,
      userId,
      creditsCharged: 500,
      createdAt: date,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const row = await findInsightsDaily(orgId, todayDateStr(), userId);
    expect(row).toBeDefined();

    const data = row!.data;
    expect(data.creditsUsed).toBe(500);

    const teamUsage = data.teamUsage as Array<{
      name: string;
      credits: number;
    }>;
    expect(teamUsage).toHaveLength(1);
    expect(teamUsage[0]!.credits).toBe(500);
  });

  it("should include credit balance from org metadata", async () => {
    const { date, dateStr } = recentDate();

    await createCompletedTestRun({
      composeVersionId,
      userId,
      createdAt: date,
      startedAt: date,
      completedAt: new Date(date.getTime() + 5000),
    });

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const row = await findInsightsDaily(orgId, todayDateStr(), userId);
    expect(row).toBeDefined();
    // ensureOrgRow inserts with default 10000 credits
    expect(row!.data.creditBalance).toBe(10000);
  });

  it("should include Axiom network data when available", async () => {
    const { date, dateStr } = recentDate();

    const runId = await createCompletedTestRun({
      composeVersionId,
      userId,
      createdAt: date,
      startedAt: date,
      completedAt: new Date(date.getTime() + 5000),
    });

    // Mock Axiom to return network logs referencing this run
    context.mocks.axiom.queryAxiom.mockResolvedValue([
      {
        _time: date.toISOString(),
        runId,
        host: "api.slack.com",
        firewall_ref: "slack",
        firewall_permission: "send_message",
        action: "ALLOW",
      },
      {
        _time: date.toISOString(),
        runId,
        host: "api.slack.com",
        firewall_ref: "slack",
        firewall_permission: "send_message",
        action: "DENY",
      },
      {
        _time: date.toISOString(),
        runId,
        host: "api.linear.app",
        firewall_ref: "linear",
        firewall_permission: "read_issues",
        action: "ALLOW",
      },
    ]);

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const row = await findInsightsDaily(orgId, todayDateStr(), userId);
    expect(row).toBeDefined();

    const data = row!.data;
    const services = data.services as Array<{
      domain: string;
      calls: number;
    }>;
    expect(services).toHaveLength(2);

    const slackService = services.find((s) => {
      return s.domain === "slack";
    });
    expect(slackService).toBeDefined();
    expect(slackService!.calls).toBe(2);

    const linearService = services.find((s) => {
      return s.domain === "linear";
    });
    expect(linearService).toBeDefined();
    expect(linearService!.calls).toBe(1);

    const permissions = data.permissions as Array<{
      label: string;
      allowed: number;
      denied: number;
    }>;
    expect(permissions).toHaveLength(2);

    // Permission labels are either human-readable descriptions or "ref:permission" fallbacks
    const slackPerm = permissions.find((p) => {
      return p.label.includes("slack") && p.label.includes("send_message");
    });
    expect(slackPerm).toBeDefined();
    expect(slackPerm!.allowed).toBe(1);
    expect(slackPerm!.denied).toBe(1);
  });

  it("should continue without network data when Axiom fails", async () => {
    const { date, dateStr } = recentDate();

    await createCompletedTestRun({
      composeVersionId,
      userId,
      createdAt: date,
      startedAt: date,
      completedAt: new Date(date.getTime() + 5000),
    });

    context.mocks.axiom.queryAxiom.mockRejectedValue(
      new Error("Axiom unavailable"),
    );

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const row = await findInsightsDaily(orgId, todayDateStr(), userId);
    expect(row).toBeDefined();

    // Agent data should still be present even without Axiom
    const agents = row!.data.agents as Array<{ runs: number }>;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.runs).toBe(1);

    // No services or permissions since Axiom failed
    expect(row!.data.services).toEqual([]);
    expect(row!.data.permissions).toEqual([]);
  });

  it("should be idempotent on rerun", async () => {
    const { date, dateStr } = recentDate();

    await createCompletedTestRun({
      composeVersionId,
      userId,
      createdAt: date,
      startedAt: date,
      completedAt: new Date(date.getTime() + 5000),
    });

    // First run
    await GET(cronRequest("test-cron-secret"));

    // Second run
    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const row = await findInsightsDaily(orgId, todayDateStr(), userId);
    const agents = row!.data.agents as Array<{ runs: number }>;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.runs).toBe(1);
  });
});
