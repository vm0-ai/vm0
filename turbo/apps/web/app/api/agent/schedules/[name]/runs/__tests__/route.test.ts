import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestSchedule,
  getTestScheduleRuns,
  insertOrgMembersCacheEntry,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../../src/lib/auth/sandbox-token";

const context = testContext();

describe("GET /api/agent/schedules/:name/runs", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(
      `runs-schedule-agent-${Date.now()}`,
    );
    testComposeId = composeId;
  });

  it("should return empty runs list", async () => {
    await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "Daily task",
    });

    const result = await getTestScheduleRuns(testComposeId, "my-schedule");

    expect(result.runs).toEqual([]);
  });

  it("should respect limit parameter", async () => {
    await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "Daily task",
    });

    // Request with explicit limit
    const result = await getTestScheduleRuns(testComposeId, "my-schedule", 10);

    expect(result.runs).toBeDefined();
    expect(Array.isArray(result.runs)).toBe(true);
  });

  it("should use default limit of 5", async () => {
    await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "Daily task",
    });

    // Request without limit parameter
    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/my-schedule/runs?composeId=${testComposeId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.runs).toBeDefined();
  });

  it("should reject limit > 100", async () => {
    await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "Daily task",
    });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/my-schedule/runs?composeId=${testComposeId}&limit=101`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    // Zod validation error for limit > 100
    expect(data.error).toBeDefined();
  });

  it("should return 404 for non-existent schedule", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/non-existent/runs?composeId=${testComposeId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/any-schedule/runs?composeId=${testComposeId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return 400 for missing composeId", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules/my-schedule/runs",
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("composeId");
  });
});

describe("GET /api/agent/schedules/:name/runs - Sandbox Token Auth", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(
      `sandbox-runs-agent-${Date.now()}`,
    );
    testComposeId = composeId;
  });

  it("should accept sandbox token with schedule:read capability", async () => {
    await createTestSchedule(testComposeId, "sandbox-runs-test", {
      cronExpression: "0 9 * * *",
      prompt: "Test",
    });

    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
    });
    mockClerk({ userId: null });
    const token = await generateSandboxToken(user.userId, "run-123", [
      "schedule:read",
    ]);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/sandbox-runs-test/runs?composeId=${testComposeId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
  });

  it("should reject sandbox token without schedule:read capability", async () => {
    mockClerk({ userId: null });
    const token = await generateSandboxToken(user.userId, "run-123", [
      "artifact:read",
    ]);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/any-schedule/runs?composeId=${testComposeId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const response = await GET(request);

    expect(response.status).toBe(403);
  });
});
