import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST, GET } from "../route";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createTestCompose,
  createTestSchedule,
  listTestSchedules,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("POST /api/agent/schedules - Deploy Schedule", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(
      `schedule-agent-${Date.now()}`,
    );
    testComposeId = composeId;
  });

  describe("Create Schedule", () => {
    it("should create schedule with cron expression", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "daily-job",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
            prompt: "Run daily at 9am",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.created).toBe(true);
      expect(data.schedule.name).toBe("daily-job");
      expect(data.schedule.cronExpression).toBe("0 9 * * *");
      expect(data.schedule.atTime).toBeNull();
      expect(data.schedule.enabled).toBe(false);
      expect(data.schedule.nextRunAt).toBeDefined();
    });

    it("should create schedule with atTime (one-time)", async () => {
      const futureTime = new Date(
        Date.now() + 24 * 60 * 60 * 1000,
      ).toISOString();

      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "one-time-job",
            atTime: futureTime,
            timezone: "UTC",
            prompt: "Run once tomorrow",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.created).toBe(true);
      expect(data.schedule.name).toBe("one-time-job");
      expect(data.schedule.cronExpression).toBeNull();
      expect(data.schedule.atTime).toBeDefined();
    });

    it("should update existing schedule (idempotent)", async () => {
      // Create initial schedule
      await createTestSchedule(testComposeId, "my-schedule", {
        cronExpression: "0 8 * * *",
        prompt: "Original prompt",
      });

      // Update the same schedule
      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "my-schedule",
            cronExpression: "0 10 * * *",
            timezone: "America/New_York",
            prompt: "Updated prompt",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.created).toBe(false);
      expect(data.schedule.cronExpression).toBe("0 10 * * *");
      expect(data.schedule.timezone).toBe("America/New_York");
      expect(data.schedule.prompt).toBe("Updated prompt");
    });
  });

  describe("Validation", () => {
    it("should reject when neither cron nor atTime provided", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "invalid-schedule",
            timezone: "UTC",
            prompt: "Missing trigger",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("cronExpression");
    });

    it("should reject when both cron and atTime provided", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "invalid-schedule",
            cronExpression: "0 9 * * *",
            atTime: new Date(Date.now() + 86400000).toISOString(),
            timezone: "UTC",
            prompt: "Both triggers",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Exactly one");
    });

    it("should reject invalid timezone", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "bad-tz-schedule",
            cronExpression: "0 9 * * *",
            timezone: "Invalid/Timezone",
            prompt: "Test",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      // BadRequestError from service is mapped to 409 in route
      expect(response.status).toBe(409);
      expect(data.error.message).toContain("timezone");
    });

    it("should reject missing composeId", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "no-compose-schedule",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
            prompt: "Test",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("composeId");
    });

    it("should reject missing name", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            cronExpression: "0 9 * * *",
            timezone: "UTC",
            prompt: "Test",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("name");
    });

    it("should reject missing prompt", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "no-prompt-schedule",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("prompt");
    });
  });

  describe("Authorization", () => {
    it("should reject unauthenticated request", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "unauth-schedule",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
            prompt: "Test",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should reject request for non-existent compose", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: randomUUID(),
            name: "missing-compose-schedule",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
            prompt: "Test",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("compose");
    });

    it("should reject request for non-owned compose", async () => {
      // Create another user and their compose
      await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        `other-agent-${Date.now()}`,
      );

      // Switch back to original user
      mockClerk({ userId: user.userId });

      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: otherComposeId,
            name: "not-my-compose-schedule",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
            prompt: "Test",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });

  describe("Schedule Limit", () => {
    it("should reject creating second schedule for same agent (1:1 constraint)", async () => {
      // Create first schedule
      await createTestSchedule(testComposeId, "first-schedule", {
        cronExpression: "0 8 * * *",
        prompt: "First",
      });

      // Try to create second schedule with different name
      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "second-schedule",
            cronExpression: "0 10 * * *",
            timezone: "UTC",
            prompt: "Second",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error.message).toContain("already has a schedule");
    });
  });
});

describe("GET /api/agent/schedules - List Schedules", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should return empty list when no schedules", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.schedules).toEqual([]);
  });

  it("should return list of user's schedules", async () => {
    // Create compose and schedule
    const { composeId } = await createTestCompose(`list-agent-${Date.now()}`);
    await createTestSchedule(composeId, "list-test-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "Test prompt",
    });

    const schedules = await listTestSchedules();

    expect(schedules.length).toBe(1);
    const schedule = schedules[0]!;
    expect(schedule.name).toBe("list-test-schedule");
    expect(schedule.composeId).toBe(composeId);
  });

  it("should not return other users' schedules", async () => {
    // Create compose and schedule as current user
    const { composeId } = await createTestCompose(`my-agent-${Date.now()}`);
    await createTestSchedule(composeId, "my-schedule", {
      cronExpression: "0 9 * * *",
      prompt: "My prompt",
    });

    // Create another user with their compose and schedule
    await context.setupUser({ prefix: "other" });
    const { composeId: otherComposeId } = await createTestCompose(
      `other-agent-${Date.now()}`,
    );
    await createTestSchedule(otherComposeId, "other-schedule", {
      cronExpression: "0 10 * * *",
      prompt: "Other prompt",
    });

    // Switch back to original user
    mockClerk({ userId: user.userId });

    const schedules = await listTestSchedules();

    expect(schedules.length).toBe(1);
    expect(schedules[0]!.name).toBe("my-schedule");
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });
});
