import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { POST, GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestOrg,
  createTestSchedule,
  enableTestSchedule,
} from "../../../../../src/__tests__/api-test-helpers";
import { createTestZeroAgent } from "../../../../../src/__tests__/db-test-seeders/agents";
import { getTestZeroAgentId } from "../../../../../src/__tests__/db-test-assertions/agents";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../src/mocks/server";
import { http } from "../../../../../src/__tests__/msw";
import { reloadEnv } from "../../../../../src/env";

const context = testContext();
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

async function setupOrg(userId: string) {
  const slug = uniqueId("zsched");
  const orgId = `org_mock_${userId}`;

  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);

  return { orgId };
}

describe("POST /api/zero/schedules - Deploy Schedule", () => {
  let orgId: string;
  let testComposeId: string;
  let testZeroAgentId: string;
  let testAgentName: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const { orgId: oid } = await setupOrg(user.userId);
    orgId = oid;

    testAgentName = `zero-sched-deploy-${Date.now()}`;
    const { composeId } = await createTestCompose(testAgentName);
    testComposeId = composeId;
    await createTestZeroAgent(orgId, testAgentName, {});
    testZeroAgentId = await getTestZeroAgentId(orgId, testAgentName);
  });

  it("should create schedule and return 201", async () => {
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "daily-zero",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Run daily",
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.created).toBe(true);
    expect(data.schedule.name).toBe("daily-zero");
    expect(data.schedule.cronExpression).toBe("0 9 * * *");
  });

  it("should update existing schedule and return 200", async () => {
    await createTestSchedule(testComposeId, "update-zero", {
      cronExpression: "0 9 * * *",
      prompt: "Original",
    });

    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "update-zero",
          cronExpression: "0 10 * * *",
          timezone: "UTC",
          prompt: "Updated",
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.created).toBe(false);
    expect(data.schedule.cronExpression).toBe("0 10 * * *");
  });

  it("should return 400 for non-existent agent", async () => {
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: "00000000-0000-0000-0000-000000000000",
          name: "will-fail",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Test",
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should create schedule with agentId", async () => {
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testComposeId,
          name: "agent-id-test",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Run via agentId",
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.created).toBe(true);
    expect(data.schedule.name).toBe("agent-id-test");
  });

  it("should default preferPersonalProvider to false when omitted", async () => {
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "no-prefer",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Test",
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.schedule.preferPersonalProvider).toBe(false);
  });

  it("should round-trip preferPersonalProvider=true on deploy", async () => {
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "with-prefer",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Test",
          preferPersonalProvider: true,
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.schedule.preferPersonalProvider).toBe(true);
  });

  it("should preserve preferPersonalProvider on update without field", async () => {
    await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "flip-prefer",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Test",
          preferPersonalProvider: true,
        }),
      }),
    );

    // Re-deploy without the field — partial-update semantics preserve the
    // previously persisted value (mirrors agent PUT/PATCH behaviour).
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "flip-prefer",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Test",
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.schedule.preferPersonalProvider).toBe(true);
  });

  it("should clear preferPersonalProvider when explicitly set to false", async () => {
    await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "explicit-clear-prefer",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Test",
          preferPersonalProvider: true,
        }),
      }),
    );

    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "explicit-clear-prefer",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Test",
          preferPersonalProvider: false,
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.schedule.preferPersonalProvider).toBe(false);
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "unauth",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Test",
        }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("should create one-time schedule with atTime", async () => {
    const futureDate = new Date(Date.now() + 86_400_000).toISOString();
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "one-time-test",
          atTime: futureDate,
          timezone: "UTC",
          prompt: "Run once",
          enabled: true,
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.schedule.triggerType).toBe("once");
    expect(data.schedule.atTime).toBe(futureDate);
  });

  it("should create loop schedule with intervalSeconds", async () => {
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "loop-test",
          intervalSeconds: 300,
          timezone: "UTC",
          prompt: "Loop every 5 minutes",
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.schedule.triggerType).toBe("loop");
    expect(data.schedule.intervalSeconds).toBe(300);
  });

  it("should reject invalid timezone", async () => {
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "bad-tz",
          cronExpression: "0 9 * * *",
          timezone: "Invalid/Timezone",
          prompt: "Bad timezone",
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should reject enabled one-time schedule with past atTime", async () => {
    const pastDate = new Date(Date.now() - 86_400_000).toISOString();
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "past-time",
          atTime: pastDate,
          timezone: "UTC",
          prompt: "Past schedule",
          enabled: true,
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("SCHEDULE_PAST");
  });

  it("should preserve enabled state and nextRunAt when update omits enabled for enabled loop", async () => {
    // Regression: an enabled loop schedule updated without the `enabled` field
    // (e.g. CLI shortening intervalSeconds) used to get nextRunAt wiped to null
    // while staying enabled=true — stranding it from executeDueSchedules.
    await createTestSchedule(testComposeId, "loop-shorten", {
      intervalSeconds: 300,
      prompt: "Loop",
    });
    await enableTestSchedule(testComposeId, "loop-shorten");

    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "loop-shorten",
          intervalSeconds: 60,
          timezone: "UTC",
          prompt: "Loop",
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.schedule.enabled).toBe(true);
    expect(data.schedule.intervalSeconds).toBe(60);
    expect(data.schedule.nextRunAt).not.toBeNull();
  });

  it("should update schedule trigger type from cron to loop", async () => {
    await createTestSchedule(testComposeId, "type-change", {
      cronExpression: "0 9 * * *",
      prompt: "Was cron",
    });

    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "type-change",
          intervalSeconds: 600,
          timezone: "UTC",
          prompt: "Now loop",
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.created).toBe(false);
    expect(data.schedule.triggerType).toBe("loop");
    expect(data.schedule.intervalSeconds).toBe(600);
    expect(data.schedule.cronExpression).toBeNull();
  });

  it("should create schedule with non-UTC timezone", async () => {
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "tokyo-sched",
          cronExpression: "0 9 * * *",
          timezone: "Asia/Tokyo",
          prompt: "Tokyo schedule",
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.schedule.timezone).toBe("Asia/Tokyo");
    expect(data.schedule.nextRunAt).toBeDefined();
  });

  it("should create schedule with description", async () => {
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "desc-test",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "With description",
          description: "Custom description for schedule",
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.schedule.description).toBe("Custom description for schedule");
  });

  it("should create schedule with fallback description when OpenRouter is rate limited", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const openRouterHandler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(
        {
          error: {
            message: "Rate limit exceeded: @ratelimit/too-many-requests.",
            code: 429,
          },
        },
        { status: 429 },
      );
    });
    server.use(openRouterHandler.handler);

    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testZeroAgentId,
          name: "openrouter-rate-limit",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Run despite description generation failing",
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.created).toBe(true);
    expect(data.schedule.description).toBe(
      `${testAgentName} recurring task: Run despite description generation failing`,
    );
    expect(openRouterHandler.mocked).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/zero/schedules - List Schedules", () => {
  let orgId: string;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const { orgId: oid } = await setupOrg(user.userId);
    orgId = oid;

    const agentName = `zero-sched-list-${Date.now()}`;
    const { composeId } = await createTestCompose(agentName);
    testComposeId = composeId;
    await createTestZeroAgent(orgId, agentName, {});
  });

  it("should return list of schedules", async () => {
    await createTestSchedule(testComposeId, "list-test-1", {
      cronExpression: "0 9 * * *",
      prompt: "First",
    });
    await createTestSchedule(testComposeId, "list-test-2", {
      cronExpression: "0 10 * * *",
      prompt: "Second",
    });

    const response = await GET(
      createTestRequest(`http://localhost:3000/api/zero/schedules`),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.schedules.length).toBeGreaterThanOrEqual(2);
  });

  it("should return empty array for invalid org", async () => {
    const response = await GET(
      createTestRequest(`http://localhost:3000/api/zero/schedules`),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.schedules).toEqual([]);
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(`http://localhost:3000/api/zero/schedules`),
    );

    expect(response.status).toBe(401);
  });
});
