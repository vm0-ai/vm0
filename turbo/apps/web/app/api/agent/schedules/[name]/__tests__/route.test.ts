import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, DELETE } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestSchedule,
  getTestSchedule,
  deleteTestSchedule,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("GET /api/agent/schedules/:name - Get Schedule", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(
      `get-schedule-agent-${Date.now()}`,
    );
    testComposeId = composeId;
  });

  it("should return schedule by name", async () => {
    const schedule = await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "Daily task",
      timezone: "America/New_York",
    });

    const retrieved = await getTestSchedule(testComposeId, "my-schedule");

    expect(retrieved.id).toBe(schedule.id);
    expect(retrieved.name).toBe("my-schedule");
    expect(retrieved.cronExpression).toBe("0 9 * * *");
    expect(retrieved.prompt).toBe("Daily task");
    expect(retrieved.timezone).toBe("America/New_York");
    expect(retrieved.composeId).toBe(testComposeId);
  });

  it("should return 404 for non-existent schedule", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/non-existent?composeId=${testComposeId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("not found");
  });

  it("should return 404 for other user's schedule", async () => {
    // Create schedule as current user
    await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "My task",
    });

    // Create another user
    const otherUser = await context.setupUser({ prefix: "other" });

    // Switch back to original user context to create their compose
    mockClerk({ userId: user.userId });

    // Try to access with original compose (owned by original user) as other user
    mockClerk({ userId: otherUser.userId });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/my-schedule?composeId=${testComposeId}`,
    );

    const response = await GET(request);

    // Returns 404 for security (don't leak existence)
    expect(response.status).toBe(404);
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/any-schedule?composeId=${testComposeId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return 400 for missing composeId query param", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules/my-schedule",
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("composeId");
  });
});

describe("DELETE /api/agent/schedules/:name - Delete Schedule", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(
      `delete-schedule-agent-${Date.now()}`,
    );
    testComposeId = composeId;
  });

  it("should delete schedule", async () => {
    await createTestSchedule(testComposeId, "to-delete", {
      cronExpression: "0 9 * * *",
      prompt: "Will be deleted",
    });

    // Verify it exists
    const before = await getTestSchedule(testComposeId, "to-delete");
    expect(before.name).toBe("to-delete");

    // Delete it
    await deleteTestSchedule(testComposeId, "to-delete");

    // Verify it's gone
    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/to-delete?composeId=${testComposeId}`,
    );
    const response = await GET(request);
    expect(response.status).toBe(404);
  });

  it("should return 404 for non-existent schedule", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/non-existent?composeId=${testComposeId}`,
      { method: "DELETE" },
    );

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 404 for other user's schedule", async () => {
    // Create schedule as current user
    await createTestSchedule(testComposeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "My task",
    });

    // Switch to other user
    const otherUser = await context.setupUser({ prefix: "other" });
    mockClerk({ userId: otherUser.userId });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/my-schedule?composeId=${testComposeId}`,
      { method: "DELETE" },
    );

    const response = await DELETE(request);

    // Returns 404 for security (don't leak existence)
    expect(response.status).toBe(404);
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/schedules/any-schedule?composeId=${testComposeId}`,
      { method: "DELETE" },
    );

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });
});
