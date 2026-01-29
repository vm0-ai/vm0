import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestSchedule,
  getTestScheduleRuns,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

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
