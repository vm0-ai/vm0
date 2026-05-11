import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST } from "../route";
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

function secretUrl(): string {
  return `http://localhost:3000/api/zero/secrets`;
}

describe("GET /api/zero/secrets", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return empty array when no secrets exist", async () => {
    const userId = uniqueId("zsec-empty");
    await setupOrg(userId);

    const response = await GET(
      createTestRequest(secretUrl(), { method: "GET" }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.secrets).toEqual([]);
  });

  it("should list secrets for authenticated user", async () => {
    const userId = uniqueId("zsec-list");
    await setupOrg(userId);

    // Create a secret first
    await POST(
      createTestRequest(secretUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "MY_SECRET",
          value: "secret-value-123",
          description: "Test secret",
        }),
      }),
    );

    const response = await GET(
      createTestRequest(secretUrl(), { method: "GET" }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.secrets).toHaveLength(1);
    expect(data.secrets[0].name).toBe("MY_SECRET");
    expect(data.secrets[0].description).toBe("Test secret");
    expect(data.secrets[0].type).toBe("user");
    expect(data.secrets[0].id).toBeDefined();
    expect(data.secrets[0].createdAt).toBeDefined();
    expect(data.secrets[0].updatedAt).toBeDefined();
    // Secrets should not expose values
    expect(data.secrets[0]).not.toHaveProperty("value");
    expect(data.secrets[0]).not.toHaveProperty("encryptedValue");
  });

  it("should reject unauthenticated requests", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/secrets", {
        method: "GET",
      }),
    );
    expect(response.status).toBe(401);
  });

  it("should return 401 when authenticated session has no organization", async () => {
    mockClerk({ userId: uniqueId("zsec-no-org"), orgId: null });

    const response = await GET(
      createTestRequest(secretUrl(), {
        method: "GET",
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });
});

describe("POST /api/zero/secrets", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should create a secret as admin", async () => {
    const userId = uniqueId("zsec-create");
    await setupOrg(userId);

    const response = await POST(
      createTestRequest(secretUrl(), {
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
    await setupOrg(userId);

    // Create
    await POST(
      createTestRequest(secretUrl(), {
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
      createTestRequest(secretUrl(), {
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
      createTestRequest("http://localhost:3000/api/zero/secrets", {
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
    await setupOrg(userId);

    const response = await POST(
      createTestRequest(secretUrl(), {
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
