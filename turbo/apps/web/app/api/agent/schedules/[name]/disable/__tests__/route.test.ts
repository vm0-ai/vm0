import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestSchedule,
  enableTestSchedule,
  disableTestSchedule,
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
      `http://localhost:3000/api/agent/schedules/my-schedule/disable`,
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

  it("should return 404 for non-existent schedule", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/non-existent/disable`,
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
      `http://localhost:3000/api/agent/schedules/any-schedule/disable`,
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
