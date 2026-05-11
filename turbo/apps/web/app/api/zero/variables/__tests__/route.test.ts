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
  const slug = uniqueId("zvar");
  const orgId = `org_mock_${userId}`;

  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);

  return { slug, orgId };
}

function variableUrl(): string {
  return `http://localhost:3000/api/zero/variables`;
}

describe("GET /api/zero/variables", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return empty array when no variables exist", async () => {
    const userId = uniqueId("zvar-empty");
    await setupOrg(userId);

    const response = await GET(
      createTestRequest(variableUrl(), { method: "GET" }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.variables).toEqual([]);
  });

  it("should list variables for authenticated user", async () => {
    const userId = uniqueId("zvar-list");
    await setupOrg(userId);

    // Create a variable first
    await POST(
      createTestRequest(variableUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "MY_VARIABLE",
          value: "variable-value-123",
          description: "Test variable",
        }),
      }),
    );

    const response = await GET(
      createTestRequest(variableUrl(), { method: "GET" }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.variables).toHaveLength(1);
    expect(data.variables[0].name).toBe("MY_VARIABLE");
    expect(data.variables[0].value).toBe("variable-value-123");
    expect(data.variables[0].description).toBe("Test variable");
    expect(data.variables[0].id).toBeDefined();
    expect(data.variables[0].createdAt).toBeDefined();
    expect(data.variables[0].updatedAt).toBeDefined();
  });

  it("should reject unauthenticated requests", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/variables", {
        method: "GET",
      }),
    );
    expect(response.status).toBe(401);
  });

  it("should return 401 when authenticated session has no organization", async () => {
    mockClerk({ userId: uniqueId("zvar-no-org"), orgId: null });

    const response = await GET(
      createTestRequest(variableUrl(), {
        method: "GET",
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });
});

describe("POST /api/zero/variables", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should create a variable as admin", async () => {
    const userId = uniqueId("zvar-create");
    await setupOrg(userId);

    const response = await POST(
      createTestRequest(variableUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "MY_VARIABLE",
          value: "variable-value-123",
          description: "Test variable",
        }),
      }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.name).toBe("MY_VARIABLE");
    expect(data.value).toBe("variable-value-123");
    expect(data.description).toBe("Test variable");
    expect(data.id).toBeDefined();
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  it("should update an existing variable", async () => {
    const userId = uniqueId("zvar-update");
    await setupOrg(userId);

    // Create
    await POST(
      createTestRequest(variableUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "MY_VARIABLE",
          value: "value-v1",
        }),
      }),
    );

    // Update
    const response = await POST(
      createTestRequest(variableUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "MY_VARIABLE",
          value: "value-v2",
          description: "Updated description",
        }),
      }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.name).toBe("MY_VARIABLE");
    expect(data.value).toBe("value-v2");
    expect(data.description).toBe("Updated description");
  });

  it("should reject unauthenticated requests", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest("http://localhost:3000/api/zero/variables", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "MY_VARIABLE",
          value: "test-value",
        }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("should reject invalid variable name", async () => {
    const userId = uniqueId("zvar-invalid");
    await setupOrg(userId);

    const response = await POST(
      createTestRequest(variableUrl(), {
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
