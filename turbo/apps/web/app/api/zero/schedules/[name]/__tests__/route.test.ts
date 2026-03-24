import { describe, it, expect, beforeEach } from "vitest";
import { DELETE } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestZeroAgent,
  getTestZeroAgentId,
  createTestOrg,
  createTestSchedule,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zsdel");
  const orgId = `org_mock_${userId}`;

  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);

  return { slug, orgId };
}

describe("DELETE /api/zero/schedules/:name", () => {
  let slug: string;
  let orgId: string;
  let testComposeId: string;
  let testZeroAgentId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const org = await setupOrg(user.userId);
    slug = org.slug;
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
        `http://localhost:3000/api/zero/schedules/to-delete?agentId=${testZeroAgentId}&org=${slug}`,
        { method: "DELETE" },
      ),
    );

    expect(response.status).toBe(204);
  });

  it("should return 404 for non-existent schedule", async () => {
    const response = await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/non-existent?agentId=${testZeroAgentId}&org=${slug}`,
        { method: "DELETE" },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should delete schedule with composeId fallback", async () => {
    await createTestSchedule(testComposeId, "del-compose", {
      cronExpression: "0 9 * * *",
      prompt: "Will be deleted via composeId",
    });

    const response = await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/del-compose?composeId=${testComposeId}&org=${slug}`,
        { method: "DELETE" },
      ),
    );

    expect(response.status).toBe(204);
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const response = await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/any?agentId=${testZeroAgentId}&org=${slug}`,
        { method: "DELETE" },
      ),
    );

    expect(response.status).toBe(401);
  });
});
