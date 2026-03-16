import { describe, it, expect, beforeEach } from "vitest";
import { POST, GET } from "../route";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createTestCompose,
  createTestSchedule,
  listTestSchedules,
  createTestSecret,
  createTestVariable,
  insertOrgMembersCacheEntry,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../src/lib/auth/sandbox-token";

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

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
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
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("should allow scheduling another user's compose (cross-org sharing)", async () => {
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
            name: "cross-org-schedule",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
            prompt: "Test cross-org",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      // Cross-org sharing: user can schedule another user's agent
      // The schedule is associated with the caller's orgId + userId
      expect(response.status).toBe(201);
      expect(data.created).toBe(true);
      expect(data.schedule.userId).toBe(user.userId);
    });
  });

  describe("Multiple Schedules (1:N)", () => {
    it("should allow creating multiple schedules for same agent with different names", async () => {
      // Create first schedule
      await createTestSchedule(testComposeId, "first-schedule", {
        cronExpression: "0 8 * * *",
        prompt: "First",
      });

      // Create second schedule with different name
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

      expect(response.status).toBe(201);
      expect(data.created).toBe(true);
      expect(data.schedule.name).toBe("second-schedule");

      // Verify both schedules exist
      const schedules = await listTestSchedules();
      const agentSchedules = schedules.filter(
        (s) => s.composeId === testComposeId,
      );
      expect(agentSchedules.length).toBe(2);
    });
  });

  describe("Loop Schedule", () => {
    it("should create loop schedule with intervalSeconds", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "loop-schedule",
            intervalSeconds: 300,
            timezone: "UTC",
            prompt: "Loop every 5 minutes",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.created).toBe(true);
      expect(data.schedule.triggerType).toBe("loop");
      expect(data.schedule.intervalSeconds).toBe(300);
      expect(data.schedule.cronExpression).toBeNull();
      expect(data.schedule.atTime).toBeNull();
      // Loop schedules don't set nextRunAt until enabled
      expect(data.schedule.nextRunAt).toBeNull();
    });

    it("should update cron schedule to loop schedule", async () => {
      // Create initial cron schedule
      await createTestSchedule(testComposeId, "my-schedule", {
        cronExpression: "0 9 * * *",
      });

      // Update to loop
      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "my-schedule",
            intervalSeconds: 60,
            timezone: "UTC",
            prompt: "Now looping",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.created).toBe(false);
      expect(data.schedule.triggerType).toBe("loop");
      expect(data.schedule.intervalSeconds).toBe(60);
      expect(data.schedule.cronExpression).toBeNull();
    });

    it("should update loop schedule to cron schedule", async () => {
      // Create initial loop schedule
      await createTestSchedule(testComposeId, "my-schedule", {
        intervalSeconds: 300,
      });

      // Update to cron
      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "my-schedule",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
            prompt: "Now cron",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.created).toBe(false);
      expect(data.schedule.triggerType).toBe("cron");
      expect(data.schedule.cronExpression).toBe("0 9 * * *");
      expect(data.schedule.intervalSeconds).toBeNull();
    });

    it("should reject when both cronExpression and intervalSeconds are specified", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/schedules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "bad-schedule",
            cronExpression: "0 9 * * *",
            intervalSeconds: 300,
            timezone: "UTC",
            prompt: "Should fail",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
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
    const { composeId } = await createTestCompose(uniqueId("list-agent"));
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
    const { composeId } = await createTestCompose(uniqueId("my-agent"));
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

  it("should include loop schedule in list with correct fields", async () => {
    const { composeId } = await createTestCompose(uniqueId("loop-list-agent"));
    await createTestSchedule(composeId, "loop-list-test", {
      intervalSeconds: 120,
      prompt: "Loop list test",
    });

    const schedules = await listTestSchedules();

    const loopSchedule = schedules.find((s) => s.name === "loop-list-test");
    expect(loopSchedule).toBeDefined();
    expect(loopSchedule!.triggerType).toBe("loop");
    expect(loopSchedule!.intervalSeconds).toBe(120);
    expect(loopSchedule!.cronExpression).toBeNull();
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

describe("POST /api/agent/schedules - Notification Control", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(`notify-agent-${Date.now()}`);
    testComposeId = composeId;
  });

  it("should default notifyEmail and notifySlack to true when not specified", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          composeId: testComposeId,
          name: "default-notify",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Test defaults",
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.schedule.notifyEmail).toBe(true);
    expect(data.schedule.notifySlack).toBe(true);
  });

  it("should create schedule with notifyEmail disabled", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          composeId: testComposeId,
          name: "no-email",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "No email",
          notifyEmail: false,
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.schedule.notifyEmail).toBe(false);
    expect(data.schedule.notifySlack).toBe(true);
  });

  it("should create schedule with notifySlack disabled", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          composeId: testComposeId,
          name: "no-slack",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "No slack",
          notifySlack: false,
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.schedule.notifyEmail).toBe(true);
    expect(data.schedule.notifySlack).toBe(false);
  });

  it("should create schedule with both notifications disabled", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          composeId: testComposeId,
          name: "silent",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Silent schedule",
          notifyEmail: false,
          notifySlack: false,
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.schedule.notifyEmail).toBe(false);
    expect(data.schedule.notifySlack).toBe(false);
  });

  it("should update notification settings on existing schedule", async () => {
    // Create schedule with notifications enabled
    await createTestSchedule(testComposeId, "update-notify", {
      cronExpression: "0 9 * * *",
      prompt: "Initial",
    });

    // Update to disable notifications
    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          composeId: testComposeId,
          name: "update-notify",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Updated",
          notifyEmail: false,
          notifySlack: false,
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.schedule.notifyEmail).toBe(false);
    expect(data.schedule.notifySlack).toBe(false);
  });

  it("should preserve notification settings when not specified in update", async () => {
    // Create schedule with notifications disabled
    const createReq = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          composeId: testComposeId,
          name: "preserve-notify",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Initial",
          notifyEmail: false,
          notifySlack: false,
        }),
      },
    );
    await POST(createReq);

    // Update without specifying notification fields
    const updateReq = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          composeId: testComposeId,
          name: "preserve-notify",
          cronExpression: "0 10 * * *",
          timezone: "UTC",
          prompt: "Updated prompt only",
        }),
      },
    );

    const response = await POST(updateReq);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.schedule.notifyEmail).toBe(false);
    expect(data.schedule.notifySlack).toBe(false);
  });

  it("should return notification fields in list response", async () => {
    const { composeId } = await createTestCompose(
      `notify-list-agent-${Date.now()}`,
    );

    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          composeId,
          name: "notify-list-test",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Test",
          notifyEmail: false,
        }),
      },
    );
    await POST(request);

    const schedules = await listTestSchedules();
    const schedule = schedules.find((s) => s.name === "notify-list-test");

    expect(schedule).toBeDefined();
    expect(schedule!.notifyEmail).toBe(false);
    expect(schedule!.notifySlack).toBe(true);
  });
});

describe("POST /api/agent/schedules - Platform Configuration Validation", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should accept schedule when required secrets exist in platform", async () => {
    // Create compose with secret reference in environment
    const { composeId } = await createTestCompose(uniqueId("secret-agent"), {
      overrides: {
        environment: {
          MY_API_KEY: "${{ secrets.MY_API_KEY }}",
        },
      },
    });

    // Create platform secret
    await createTestSecret("MY_API_KEY", "test-secret-value");

    // Create schedule without passing secrets (should use platform secrets)
    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          composeId,
          name: "secret-test-schedule",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Test with platform secrets",
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.created).toBe(true);
    expect(data.schedule.name).toBe("secret-test-schedule");
  });

  it("should reject schedule when required secrets missing from platform", async () => {
    // Create compose with secret reference that doesn't exist in platform
    const { composeId } = await createTestCompose(
      uniqueId("missing-secret-agent"),
      {
        overrides: {
          environment: {
            MISSING_SECRET: "${{ secrets.MISSING_SECRET }}",
          },
        },
      },
    );

    // Do NOT create the platform secret

    // Try to create schedule - should fail
    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          composeId,
          name: "missing-secret-schedule",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Test with missing secrets",
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should accept schedule when required vars exist in platform", async () => {
    // Create compose with var reference in environment
    const { composeId } = await createTestCompose(uniqueId("var-agent"), {
      overrides: {
        environment: {
          MY_VAR: "${{ vars.MY_VAR }}",
        },
      },
    });

    // Create platform variable
    await createTestVariable("MY_VAR", "test-var-value");

    // Create schedule without passing vars (should use platform vars)
    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          composeId,
          name: "var-test-schedule",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Test with platform vars",
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.created).toBe(true);
  });

  it("should reject schedule when required vars missing from platform", async () => {
    // Create compose with var reference that doesn't exist in platform
    const { composeId } = await createTestCompose(
      uniqueId("missing-var-agent"),
      {
        overrides: {
          environment: {
            MISSING_VAR: "${{ vars.MISSING_VAR }}",
          },
        },
      },
    );

    // Do NOT create the platform variable

    // Try to create schedule - should fail
    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          composeId,
          name: "missing-var-schedule",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Test with missing vars",
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });
});

describe("POST /api/agent/schedules - Sandbox Token Auth", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(
      `sandbox-deploy-agent-${Date.now()}`,
    );
    testComposeId = composeId;

    // Populate membership cache so resolveOrg works without Clerk session
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
    });

    // Clear Clerk session so sandbox token path is exercised
    mockClerk({ userId: null });
  });

  it("should accept sandbox token with schedule:write capability", async () => {
    const token = await generateSandboxToken(user.userId, "run-123", [
      "schedule:write",
    ]);

    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          composeId: testComposeId,
          name: "sandbox-schedule",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Sandbox deploy test",
        }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(201);
  });

  it("should reject sandbox token without schedule:write capability", async () => {
    const token = await generateSandboxToken(user.userId, "run-123", [
      "storage:read",
    ]);

    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          composeId: testComposeId,
          name: "sandbox-schedule",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Should be rejected",
        }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(403);
  });
});

describe("GET /api/agent/schedules - Sandbox Token Auth", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Populate membership cache so resolveOrg works without Clerk session
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
    });

    // Clear Clerk session so sandbox token path is exercised
    mockClerk({ userId: null });
  });

  it("should accept sandbox token with schedule:read capability", async () => {
    const token = await generateSandboxToken(user.userId, "run-123", [
      "schedule:read",
    ]);

    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
  });

  it("should reject sandbox token without schedule:read capability", async () => {
    const token = await generateSandboxToken(user.userId, "run-123", [
      "storage:read",
    ]);

    const request = createTestRequest(
      "http://localhost:3000/api/agent/schedules",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const response = await GET(request);

    expect(response.status).toBe(403);
  });
});
