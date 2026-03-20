import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestOrg,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

/**
 * Setup an org with the given user as admin.
 */
async function setupOrg(userId: string) {
  const slug = uniqueId("zsec");
  const orgId = `org_mock_${userId}`;

  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);

  return { slug, orgId };
}

function secretUrl(slug: string): string {
  return `http://localhost:3000/api/zero/secrets?org=${slug}`;
}

describe("POST /api/zero/secrets", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should create a secret as admin", async () => {
    const userId = uniqueId("zsec-create");
    const { slug } = await setupOrg(userId);

    const response = await POST(
      createTestRequest(secretUrl(slug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "MY_SECRET",
          value: "secret-value-123",
          description: "Test secret",
        }),
      }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.name).toBe("MY_SECRET");
    expect(data.description).toBe("Test secret");
    expect(data.type).toBe("user");
    expect(data.id).toBeDefined();
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  it("should update an existing secret", async () => {
    const userId = uniqueId("zsec-update");
    const { slug } = await setupOrg(userId);

    // Create
    await POST(
      createTestRequest(secretUrl(slug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "MY_SECRET",
          value: "value-v1",
        }),
      }),
    );

    // Update
    const response = await POST(
      createTestRequest(secretUrl(slug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "MY_SECRET",
          value: "value-v2",
          description: "Updated description",
        }),
      }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.name).toBe("MY_SECRET");
    expect(data.description).toBe("Updated description");
  });

  it("should reject unauthenticated requests", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest("http://localhost:3000/api/zero/secrets?org=test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "MY_SECRET",
          value: "test-value",
        }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("should reject invalid secret name", async () => {
    const userId = uniqueId("zsec-invalid");
    const { slug } = await setupOrg(userId);

    const response = await POST(
      createTestRequest(secretUrl(slug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "invalid name with spaces",
          value: "test-value",
        }),
      }),
    );
    expect(response.status).toBe(400);
  });
});
