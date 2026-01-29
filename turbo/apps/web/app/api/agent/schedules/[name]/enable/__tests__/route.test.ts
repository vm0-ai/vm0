import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestSchedule,
  enableTestSchedule,
  getTestSchedule,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("POST /api/agent/schedules/:name/enable", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(
      `enable-schedule-agent-${Date.now()}`,
    );
    testComposeId = composeId;
  });

  it("should enable a disabled schedule", async () => {
    // Create a schedule (starts disabled)
    await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "Daily task",
    });

    // Verify it's disabled
    const before = await getTestSchedule(testComposeId, "my-schedule");
    expect(before.enabled).toBe(false);

    // Enable it
    const enabled = await enableTestSchedule(testComposeId, "my-schedule");

    expect(enabled.enabled).toBe(true);
    expect(enabled.nextRunAt).toBeDefined();
  });

  it("should be idempotent for already enabled schedule", async () => {
    await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "Daily task",
    });

    // Enable twice
    const first = await enableTestSchedule(testComposeId, "my-schedule");
    const second = await enableTestSchedule(testComposeId, "my-schedule");

    expect(first.enabled).toBe(true);
    expect(second.enabled).toBe(true);
  });

  it("should reject invalid JSON body", async () => {
    await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "Test",
    });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/my-schedule/enable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ name: "my-schedule" }),
    });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("Invalid JSON");
  });

  it("should reject missing composeId", async () => {
    await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "Test",
    });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/my-schedule/enable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ name: "my-schedule" }),
    });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("composeId");
  });

  it("should return 400 for expired one-time schedule (SchedulePastError)", async () => {
    // Create a one-time schedule with a time in the past
    const pastTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Use direct database access to create past schedule since API validates
    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          composeId: testComposeId,
          name: "past-schedule",
          atTime: pastTime,
          timezone: "UTC",
          prompt: "Already passed",
        }),
      },
    );

    // Import and call the deploy route directly
    const { POST: deployRoute } = await import("../../../route");
    await deployRoute(request);

    // Try to enable the past schedule
    const enableRequest = createTestRequest(
      `http://localhost:3000/api/agent/schedules/past-schedule/enable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composeId: testComposeId }),
      },
    );

    const response = await POST(enableRequest, {
      params: Promise.resolve({ name: "past-schedule" }),
    });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("SCHEDULE_PAST");
  });

  it("should return 404 for non-existent schedule", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/non-existent/enable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composeId: testComposeId }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ name: "non-existent" }),
    });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/any-schedule/enable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composeId: testComposeId }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ name: "any-schedule" }),
    });
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });
});
