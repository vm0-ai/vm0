import { randomUUID } from "crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  insertTestQueueEntry,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { seedTestRun } from "../../../../../src/__tests__/db-test-seeders/runs";

const context = testContext();

describe("GET /api/zero/queue-position", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("queue-pos"));
    testComposeId = composeId;
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/queue-position?runId=${randomUUID()}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 when runId is missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/queue-position",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return 404 when run does not belong to user", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/zero/queue-position?runId=${randomUUID()}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return position 0 when run is not in queue", async () => {
    const { runId } = await seedTestRun(user.userId, testComposeId, {
      status: "running",
    });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/queue-position?runId=${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.position).toBe(0);
    expect(data.total).toBe(0);
  });

  it("should return 404 for run from a different org", async () => {
    // Create compose in a different org
    const otherOrg = await context.createAgentCompose(user.userId);

    // Create run in the other org
    const { runId } = await seedTestRun(user.userId, otherOrg.id, {
      status: "running",
    });

    // Access with default org context — the run belongs to otherOrg
    const request = createTestRequest(
      `http://localhost:3000/api/zero/queue-position?runId=${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return position when run is queued", async () => {
    const { runId } = await seedTestRun(user.userId, testComposeId, {
      status: "queued",
    });

    // Use an explicit createdAt with whole-second precision to avoid
    // PostgreSQL microsecond vs JavaScript millisecond precision mismatch
    // in the route's lte() timestamp comparison.
    await insertTestQueueEntry(runId, {
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/queue-position?runId=${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.position).toBe(1);
    expect(data.total).toBe(1);
  });
});
