import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/org-test-helpers";

const context = testContext();

describe("POST /api/org - Create Organization", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: uniqueId("org") }),
    });
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should create org and return 201 with slug, role, members", async () => {
    // Use a fresh user without an existing scope (don't call setupUser)
    const userId = uniqueId("org-creator");
    const slug = uniqueId("org");
    setupClerkOrgMock({ userId });

    const request = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.slug).toBe(slug);
    expect(data.role).toBe("admin");
    expect(data.members).toHaveLength(1);
    expect(data.members[0].role).toBe("admin");
    expect(data.createdAt).toBeTruthy();
  });

  it("should reject duplicate org", async () => {
    // First user creates an org
    const userId1 = uniqueId("org-user1");
    const slug1 = uniqueId("org");
    setupClerkOrgMock({ userId: userId1 });

    const request1 = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: slug1 }),
    });
    const response1 = await POST(request1);
    expect(response1.status).toBe(201);

    // Same user tries to create another org — should fail
    const slug2 = uniqueId("org");
    const request2 = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: slug2 }),
    });
    const response2 = await POST(request2);
    expect(response2.status).toBe(400);

    const data = await response2.json();
    expect(data.error.message).toContain("already have a scope");
  });
});
