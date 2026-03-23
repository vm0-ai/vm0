import { describe, it, expect, beforeEach } from "vitest";
import { DELETE } from "../route";
import {
  createTestRequest,
  createTestCompose,
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
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const org = await setupOrg(user.userId);
    slug = org.slug;

    const { composeId } = await createTestCompose(
      `zero-sched-del-${Date.now()}`,
    );
    testComposeId = composeId;
  });

  it("should delete schedule and return 204", async () => {
    await createTestSchedule(testComposeId, "to-delete", {
      cronExpression: "0 9 * * *",
      prompt: "Will be deleted",
    });

    const response = await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/to-delete?composeId=${testComposeId}&org=${slug}`,
        { method: "DELETE" },
      ),
    );

    expect(response.status).toBe(204);
  });

  it("should return 404 for non-existent schedule", async () => {
    const response = await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/non-existent?composeId=${testComposeId}&org=${slug}`,
        { method: "DELETE" },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const response = await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/any?composeId=${testComposeId}&org=${slug}`,
        { method: "DELETE" },
      ),
    );

    expect(response.status).toBe(401);
  });
});
