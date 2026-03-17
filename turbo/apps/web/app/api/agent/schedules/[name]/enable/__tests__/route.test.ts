import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { POST as deployRoute } from "../../../route";
import {
  createTestRequest,
  createTestCompose,
  createTestSchedule,
  enableTestSchedule,
  getTestSchedule,
  updateTestScheduleState,
  insertOrgMembersCacheEntry,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../../src/lib/auth/sandbox-token";

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
    expect(data.error.message).toContain("composeId must be a valid UUID");
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
    expect(data.error.message).toContain("composeId must be a valid UUID");
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

  it("should enable loop schedule with nextRunAt set to now", async () => {
    const schedule = await createTestSchedule(testComposeId, "loop-schedule", {
      intervalSeconds: 300,
      prompt: "Loop task",
    });

    expect(schedule.enabled).toBe(false);

    const before = Date.now();
    const enabled = await enableTestSchedule(testComposeId, "loop-schedule");

    expect(enabled.enabled).toBe(true);
    expect(enabled.nextRunAt).not.toBeNull();
    expect(enabled.consecutiveFailures).toBe(0);
    // Loop schedules should trigger immediately (nextRunAt ~= now)
    const nextRunTime = new Date(enabled.nextRunAt!).getTime();
    expect(nextRunTime).toBeGreaterThanOrEqual(before - 1000);
    expect(nextRunTime).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("should reset consecutiveFailures when re-enabling loop schedule", async () => {
    const schedule = await createTestSchedule(testComposeId, "loop-reset", {
      intervalSeconds: 60,
      prompt: "Reset test",
    });

    // Enable first
    await enableTestSchedule(testComposeId, "loop-reset");

    // Simulate failures via test helper
    await updateTestScheduleState(schedule.id, {
      consecutiveFailures: 2,
      enabled: false,
    });

    // Re-enable
    const reEnabled = await enableTestSchedule(testComposeId, "loop-reset");

    expect(reEnabled.enabled).toBe(true);
    expect(reEnabled.consecutiveFailures).toBe(0);
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

describe("POST /api/agent/schedules/:name/enable - Sandbox Token Auth", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(
      `sandbox-enable-agent-${Date.now()}`,
    );
    testComposeId = composeId;
  });

  it("should accept sandbox token with schedule:write capability", async () => {
    await createTestSchedule(testComposeId, "sandbox-enable-test", {
      cronExpression: "0 9 * * *",
      prompt: "Test",
    });

    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
    });
    mockClerk({ userId: null, orgId: user.orgId });
    const token = await generateSandboxToken(user.userId, "run-123", [
      "schedule:write",
    ]);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/sandbox-enable-test/enable`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ composeId: testComposeId }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ name: "sandbox-enable-test" }),
    });

    expect(response.status).toBe(200);
  });

  it("should reject sandbox token without schedule:write capability", async () => {
    mockClerk({ userId: null });
    const token = await generateSandboxToken(user.userId, "run-123", [
      "artifact:read",
    ]);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/any-schedule/enable`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ composeId: testComposeId }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ name: "any-schedule" }),
    });

    expect(response.status).toBe(403);
  });
});
