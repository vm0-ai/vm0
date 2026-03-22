import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestSchedule,
  enableTestSchedule,
  disableTestSchedule,
  getTestSchedule,
  insertOrgMembersCacheEntry,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../../src/lib/auth/sandbox-token";

const context = testContext();

describe("POST /api/agent/schedules/:name/disable", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(
      `disable-schedule-agent-${Date.now()}`,
    );
    testComposeId = composeId;
  });

  it("should disable an enabled schedule", async () => {
    // Create and enable a schedule
    await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "Daily task",
    });
    await enableTestSchedule(testComposeId, "my-schedule");

    // Verify it's enabled
    const before = await getTestSchedule(testComposeId, "my-schedule");
    expect(before.enabled).toBe(true);

    // Disable it
    const disabled = await disableTestSchedule(testComposeId, "my-schedule");

    expect(disabled.enabled).toBe(false);
  });

  it("should be idempotent for already disabled schedule", async () => {
    await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "Daily task",
    });

    // Disable twice (schedule starts disabled)
    const first = await disableTestSchedule(testComposeId, "my-schedule");
    const second = await disableTestSchedule(testComposeId, "my-schedule");

    expect(first.enabled).toBe(false);
    expect(second.enabled).toBe(false);
  });

  it("should reject invalid JSON body", async () => {
    await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "Test",
    });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/my-schedule/disable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      },
    );

    const response = await POST(request);

    // createSafeErrorHandler returns 500 for non-validation errors (SyntaxError)
    expect(response.status).toBe(500);
  });

  it("should reject missing composeId", async () => {
    await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "Test",
    });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/my-schedule/disable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return 404 for non-existent schedule", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/non-existent/disable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composeId: testComposeId }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should disable an enabled loop schedule", async () => {
    // Create and enable a loop schedule
    await createTestSchedule(testComposeId, "loop-schedule", {
      intervalSeconds: 300,
      prompt: "Loop task",
    });
    await enableTestSchedule(testComposeId, "loop-schedule");

    // Verify it's enabled
    const before = await getTestSchedule(testComposeId, "loop-schedule");
    expect(before.enabled).toBe(true);
    expect(before.triggerType).toBe("loop");

    // Disable it
    const disabled = await disableTestSchedule(testComposeId, "loop-schedule");

    expect(disabled.enabled).toBe(false);
    expect(disabled.triggerType).toBe("loop");
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/any-schedule/disable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composeId: testComposeId }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });
});

describe("POST /api/agent/schedules/:name/disable - Sandbox Token Auth", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(
      `sandbox-disable-agent-${Date.now()}`,
    );
    testComposeId = composeId;
  });

  it("should accept sandbox token with schedule:write capability", async () => {
    await createTestSchedule(testComposeId, "sandbox-disable-test", {
      cronExpression: "0 9 * * *",
      prompt: "Test",
    });
    await enableTestSchedule(testComposeId, "sandbox-disable-test");

    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
    });
    const orgSlug = `org-${user.userId.slice(-8)}`;
    mockClerk({ userId: null, orgId: user.orgId });
    const token = await generateSandboxToken(user.userId, "run-123", [
      "schedule:write",
    ]);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/sandbox-disable-test/disable?org=${orgSlug}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ composeId: testComposeId }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(200);
  });

  it("should reject sandbox token without schedule:write capability", async () => {
    mockClerk({ userId: null });
    const token = await generateSandboxToken(user.userId, "run-123", [
      "artifact:read",
    ]);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/any-schedule/disable`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ composeId: testComposeId }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(403);
  });
});
