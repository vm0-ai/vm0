import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestOrg,
  createTestSchedule,
  enableTestSchedule,
  getTestSchedule,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zsdis");
  const orgId = `org_mock_${userId}`;

  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);

  return { slug, orgId };
}

describe("POST /api/zero/schedules/:name/disable", () => {
  let slug: string;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const org = await setupOrg(user.userId);
    slug = org.slug;

    const { composeId } = await createTestCompose(
      `zero-sched-disable-${Date.now()}`,
    );
    testComposeId = composeId;
  });

  it("should disable an enabled schedule", async () => {
    await createTestSchedule(testComposeId, "to-disable", {
      cronExpression: "0 9 * * *",
      prompt: "Disable test",
    });
    await enableTestSchedule(testComposeId, "to-disable");

    const before = await getTestSchedule(testComposeId, "to-disable");
    expect(before.enabled).toBe(true);

    const response = await POST(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/to-disable/disable?org=${slug}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ composeId: testComposeId }),
        },
      ),
      { params: Promise.resolve({ name: "to-disable" }) },
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.enabled).toBe(false);
  });

  it("should return 404 for non-existent schedule", async () => {
    const response = await POST(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/non-existent/disable?org=${slug}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ composeId: testComposeId }),
        },
      ),
      { params: Promise.resolve({ name: "non-existent" }) },
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 400 for invalid body", async () => {
    const response = await POST(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/any/disable?org=${slug}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
      { params: Promise.resolve({ name: "any" }) },
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest(
        `http://localhost:3000/api/zero/schedules/any/disable?org=${slug}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ composeId: testComposeId }),
        },
      ),
      { params: Promise.resolve({ name: "any" }) },
    );

    expect(response.status).toBe(401);
  });
});
