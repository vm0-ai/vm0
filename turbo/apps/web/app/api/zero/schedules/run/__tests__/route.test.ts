import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestOrg,
  createTestSchedule,
  enableTestSchedule,
} from "../../../../../../src/__tests__/api-test-helpers";
import { createTestZeroAgent } from "../../../../../../src/__tests__/db-test-seeders/agents";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zsrun");
  const orgId = `org_mock_${userId}`;

  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);

  return { slug, orgId };
}

describe("POST /api/zero/schedules/run", () => {
  let orgId: string;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const org = await setupOrg(user.userId);
    orgId = org.orgId;

    const agentName = uniqueId("run-agent");
    const { composeId } = await createTestCompose(agentName);
    testComposeId = composeId;
    await createTestZeroAgent(orgId, agentName, {});
  });

  it("should execute schedule and return runId with 201", async () => {
    const schedule = await createTestSchedule(testComposeId, "run-test", {
      cronExpression: "0 9 * * *",
      prompt: "Manual run test",
    });
    await enableTestSchedule(testComposeId, "run-test");

    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduleId: schedule.id }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.runId).toBeDefined();
    expect(typeof data.runId).toBe("string");
  });

  it("should return 404 for non-existent schedule", async () => {
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduleId: "00000000-0000-0000-0000-000000000000",
        }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 409 when previous run is still active", async () => {
    const schedule = await createTestSchedule(testComposeId, "conflict-test", {
      cronExpression: "0 9 * * *",
      prompt: "Conflict test",
    });
    await enableTestSchedule(testComposeId, "conflict-test");

    // Execute once to create a run and set lastRunId
    const firstResponse = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduleId: schedule.id }),
      }),
    );
    expect(firstResponse.status).toBe(201);

    // Try to run again while previous run is still active (pending/running)
    const secondResponse = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduleId: schedule.id }),
      }),
    );
    const data = await secondResponse.json();

    expect(secondResponse.status).toBe(409);
    expect(data.error.code).toBe("CONFLICT");
  });

  it("should return 400 for invalid body (missing scheduleId)", async () => {
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 for invalid scheduleId format", async () => {
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduleId: "not-a-uuid" }),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduleId: "00000000-0000-0000-0000-000000000000",
        }),
      }),
    );

    expect(response.status).toBe(401);
  });
});
