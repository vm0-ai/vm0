import { describe, it, expect, beforeEach } from "vitest";
import { POST, GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestOrg,
  createTestSchedule,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zsched");
  const orgId = `org_mock_${userId}`;

  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);

  return { slug, orgId };
}

describe("POST /api/zero/schedules - Deploy Schedule", () => {
  let slug: string;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const org = await setupOrg(user.userId);
    slug = org.slug;

    const { composeId } = await createTestCompose(
      `zero-sched-deploy-${Date.now()}`,
    );
    testComposeId = composeId;
  });

  it("should create schedule and return 201", async () => {
    const response = await POST(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules?org=${slug}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "daily-zero",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
            prompt: "Run daily",
          }),
        },
      ),
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
      createTestRequest(
        `http://localhost:3000/api/zero/schedules?org=${slug}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "update-zero",
            cronExpression: "0 10 * * *",
            timezone: "UTC",
            prompt: "Updated",
          }),
        },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.created).toBe(false);
    expect(data.schedule.cronExpression).toBe("0 10 * * *");
  });

  it("should return 400 for non-existent compose", async () => {
    const response = await POST(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules?org=${slug}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: "non-existent-compose-id",
            name: "will-fail",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
            prompt: "Test",
          }),
        },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules?org=${slug}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: testComposeId,
            name: "unauth",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
            prompt: "Test",
          }),
        },
      ),
    );

    expect(response.status).toBe(401);
  });
});

describe("GET /api/zero/schedules - List Schedules", () => {
  let slug: string;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const org = await setupOrg(user.userId);
    slug = org.slug;

    const { composeId } = await createTestCompose(
      `zero-sched-list-${Date.now()}`,
    );
    testComposeId = composeId;
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
      createTestRequest(`http://localhost:3000/api/zero/schedules?org=${slug}`),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.schedules.length).toBeGreaterThanOrEqual(2);
  });

  it("should return empty array for invalid org", async () => {
    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules?org=non-existent-org`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.schedules).toEqual([]);
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(`http://localhost:3000/api/zero/schedules?org=${slug}`),
    );

    expect(response.status).toBe(401);
  });
});
