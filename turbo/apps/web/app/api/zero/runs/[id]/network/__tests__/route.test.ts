import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { GET } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { seedTestRun } from "../../../../../../../src/__tests__/db-test-seeders/runs";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("znet");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function networkUrl(runId: string): string {
  return `http://localhost:3000/api/zero/runs/${runId}/network`;
}

function makeAxiomEvent(overrides: Record<string, unknown> = {}) {
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
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return network logs for a run", async () => {
    const userId = uniqueId("znet-get");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("znet")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "completed",
    });

    const httpEvent = makeAxiomEvent({ runId, userId });
    const tcpEvent = makeAxiomEvent({
      runId,
      userId,
      type: "tcp",
      action: undefined,
      method: undefined,
      url: undefined,
      status: undefined,
      host: "redis.example.com",
      port: 6379,
    });

    context.mocks.axiom.queryAxiom.mockResolvedValue([httpEvent, tcpEvent]);

    const response = await GET(createTestRequest(networkUrl(runId)));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.networkLogs).toHaveLength(2);
    expect(data.hasMore).toBe(false);

    expect(data.networkLogs[0].type).toBe("http");
    expect(data.networkLogs[0].method).toBe("GET");
    expect(data.networkLogs[0].url).toBe("https://api.example.com/data");
    expect(data.networkLogs[0].status).toBe(200);

    expect(data.networkLogs[1].type).toBe("tcp");
    expect(data.networkLogs[1].host).toBe("redis.example.com");
    expect(data.networkLogs[1].port).toBe(6379);
  });

  it("should return empty array when no logs", async () => {
    const userId = uniqueId("znet-empty");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("znet")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "completed",
    });

    context.mocks.axiom.queryAxiom.mockResolvedValue([]);

    const response = await GET(createTestRequest(networkUrl(runId)));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.networkLogs).toEqual([]);
    expect(data.hasMore).toBe(false);
  });

  it("should return 404 when run not found", async () => {
    const userId = uniqueId("znet-nf");
    await setupOrg(userId);

    const response = await GET(createTestRequest(networkUrl(randomUUID())));
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/runs/00000000-0000-0000-0000-000000000000/network",
      ),
    );
    expect(response.status).toBe(401);
  });

  it("should set hasMore when results exceed limit", async () => {
    const userId = uniqueId("znet-more");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("znet")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "completed",
    });

    // Query with limit=2, return 3 events to trigger hasMore
    const events = Array.from({ length: 3 }, (_, i) => {
      return makeAxiomEvent({
        runId,
        userId,
        url: `https://api.example.com/${i}`,
      });
    });
    context.mocks.axiom.queryAxiom.mockResolvedValue(events);

    const url = `${networkUrl(runId)}?limit=2`;
    const response = await GET(createTestRequest(url));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.networkLogs).toHaveLength(2);
    expect(data.hasMore).toBe(true);
  });
});
