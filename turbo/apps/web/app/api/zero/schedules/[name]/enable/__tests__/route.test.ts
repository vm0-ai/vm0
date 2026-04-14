import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestOrg,
  createTestSchedule,
  getTestSchedule,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { createTestZeroAgent } from "../../../../../../../src/__tests__/db-test-seeders/agents";
import { getTestZeroAgentId } from "../../../../../../../src/__tests__/db-test-assertions/agents";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zsen");
  const orgId = `org_mock_${userId}`;

  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);

  return { slug, orgId };
}

describe("POST /api/zero/schedules/:name/enable", () => {
  let orgId: string;
  let testComposeId: string;
  let testZeroAgentId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const org = await setupOrg(user.userId);
    orgId = org.orgId;

    const agentName = `zero-sched-enable-${Date.now()}`;
    const { composeId } = await createTestCompose(agentName);
    testComposeId = composeId;
    await createTestZeroAgent(orgId, agentName, {});
    testZeroAgentId = await getTestZeroAgentId(orgId, agentName);
  });

  it("should enable a disabled schedule", async () => {
    await createTestSchedule(testComposeId, "to-enable", {
      cronExpression: "0 9 * * *",
      prompt: "Enable test",
    });

    const before = await getTestSchedule(testComposeId, "to-enable");
    expect(before.enabled).toBe(false);

    const response = await POST(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/to-enable/enable`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: testZeroAgentId }),
        },
      ),
      { params: Promise.resolve({ name: "to-enable" }) },
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.enabled).toBe(true);
  });

  it("should return 404 for non-existent schedule", async () => {
    const response = await POST(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/non-existent/enable`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: testZeroAgentId }),
        },
      ),
      { params: Promise.resolve({ name: "non-existent" }) },
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should enable schedule with agentId", async () => {
    await createTestSchedule(testComposeId, "enable-agentid", {
      cronExpression: "0 9 * * *",
      prompt: "Enable via agentId",
    });

    const response = await POST(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/enable-agentid/enable`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: testComposeId }),
        },
      ),
      { params: Promise.resolve({ name: "enable-agentid" }) },
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.enabled).toBe(true);
  });

  it("should return 400 for invalid body", async () => {
    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules/any/enable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ name: "any" }) },
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest(`http://localhost:3000/api/zero/schedules/any/enable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testZeroAgentId }),
      }),
      { params: Promise.resolve({ name: "any" }) },
    );

    expect(response.status).toBe(401);
  });
});
