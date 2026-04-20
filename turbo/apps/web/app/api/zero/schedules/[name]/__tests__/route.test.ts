import { describe, it, expect, beforeEach } from "vitest";
import { DELETE } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestOrg,
  createTestSchedule,
  insertOrgMembersCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import { createTestZeroAgent } from "../../../../../../src/__tests__/db-test-seeders/agents";
import { getTestZeroAgentId } from "../../../../../../src/__tests__/db-test-assertions/agents";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../../src/lib/auth/sandbox-token";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zsdel");
  const orgId = `org_mock_${userId}`;

  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);

  return { slug, orgId };
}

describe("DELETE /api/zero/schedules/:name", () => {
  let userId: string;
  let orgId: string;
  let testComposeId: string;
  let testZeroAgentId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const org = await setupOrg(user.userId);
    orgId = org.orgId;

    const agentName = `zero-sched-del-${Date.now()}`;
    const { composeId } = await createTestCompose(agentName);
    testComposeId = composeId;
    await createTestZeroAgent(orgId, agentName, {});
    testZeroAgentId = await getTestZeroAgentId(orgId, agentName);
  });

  it("should delete schedule and return 204", async () => {
    await createTestSchedule(testComposeId, "to-delete", {
      cronExpression: "0 9 * * *",
      prompt: "Will be deleted",
    });

    const response = await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/to-delete?agentId=${testZeroAgentId}`,
        { method: "DELETE" },
      ),
    );

    expect(response.status).toBe(204);
  });

  it("should return 404 for non-existent schedule", async () => {
    const response = await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/non-existent?agentId=${testZeroAgentId}`,
        { method: "DELETE" },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should delete schedule with agentId", async () => {
    await createTestSchedule(testComposeId, "del-agent-id", {
      cronExpression: "0 9 * * *",
      prompt: "Will be deleted via agentId",
    });

    const response = await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/del-agent-id?agentId=${testComposeId}`,
        { method: "DELETE" },
      ),
    );

    expect(response.status).toBe(204);
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const response = await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/any?agentId=${testZeroAgentId}`,
        { method: "DELETE" },
      ),
    );

    expect(response.status).toBe(401);
  });

  it("should reject agent run token (schedule:delete is agent-excluded)", async () => {
    await createTestSchedule(testComposeId, "agent-cant-delete", {
      cronExpression: "0 9 * * *",
      prompt: "Agent should not delete this",
    });

    await insertOrgMembersCacheEntry({
      userId,
      orgId,
      role: "admin",
    });

    // Switch to zero token auth (agent run) — no Clerk session
    mockClerk({ userId: null });
    const token = await generateZeroToken(userId, "run-123", orgId);

    const response = await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/agent-cant-delete?agentId=${testZeroAgentId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      ),
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error.message).toBe(
      "Missing required capability: schedule:delete",
    );
  });
});
