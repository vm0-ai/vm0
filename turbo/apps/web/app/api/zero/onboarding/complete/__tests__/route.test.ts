import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { GET as getStatus } from "../../status/route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("POST /api/zero/onboarding/complete", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/complete",
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should mark onboarding as done for a member", async () => {
    const user = await context.setupUser();

    // Re-mock as a member (not admin) so status route checks org_members_cache
    mockClerk({
      userId: user.userId,
      orgRole: "org:member",
      clerkOrgs: [
        {
          id: user.orgId,
          slug: `org-${user.userId}`,
          name: `org-${user.userId}`,
          role: "org:member",
        },
      ],
    });

    // Before completing onboarding: member should need onboarding
    const beforeRequest = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/status",
    );
    const beforeResponse = await getStatus(beforeRequest);
    const beforeData = await beforeResponse.json();
    expect(beforeData.needsOnboarding).toBe(true);

    // Complete onboarding
    const request = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/complete",
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });

    // After completing onboarding: member should no longer need onboarding
    const afterRequest = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/status",
    );
    const afterResponse = await getStatus(afterRequest);
    const afterData = await afterResponse.json();
    expect(afterData.needsOnboarding).toBe(false);
  });

  it("should be idempotent when called multiple times", async () => {
    await context.setupUser();

    const makeRequest = () => {
      return POST(
        createTestRequest(
          "http://localhost:3000/api/zero/onboarding/complete",
          {
            method: "POST",
            body: JSON.stringify({}),
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    };

    const first = await makeRequest();
    expect(first.status).toBe(200);

    const second = await makeRequest();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
  });
});
