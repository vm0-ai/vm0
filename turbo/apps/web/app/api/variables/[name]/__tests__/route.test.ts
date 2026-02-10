import { describe, it, expect, beforeEach } from "vitest";
import { GET, DELETE } from "../route";
import { PUT } from "../../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

/**
 * Helper to create a variable for testing
 */
async function createVariable(
  name: string,
  value: string,
  description?: string,
): Promise<{ id: string; name: string; value: string }> {
  const request = createTestRequest("http://localhost:3000/api/variables", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, value, description }),
  });
  const response = await PUT(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to create variable: ${error.error?.message}`);
  }
  return response.json();
}

describe("GET /api/variables/:name - Get Variable", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/variables/TEST_VAR",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return variable with value by name", async () => {
    await createVariable("MY_VAR", "my-secret-value", "My variable");

    const request = createTestRequest(
      "http://localhost:3000/api/variables/MY_VAR",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.name).toBe("MY_VAR");
    expect(data.value).toBe("my-secret-value");
    expect(data.description).toBe("My variable");
    expect(data.id).toBeDefined();
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  it("should return 404 for nonexistent variable", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/variables/NONEXISTENT_VAR",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("NONEXISTENT_VAR");
  });

  it("should return 404 for other user's variable", async () => {
    // Create variable as current user
    await createVariable("USER1_VAR", "user1-value");

    // Switch to other user
    await context.setupUser({ prefix: "other-user" });

    const request = createTestRequest(
      "http://localhost:3000/api/variables/USER1_VAR",
    );
    const response = await GET(request);

    // Returns 404 for security (don't leak existence)
    expect(response.status).toBe(404);

    // Switch back to original user and verify it still exists
    mockClerk({ userId: user.userId });
    const request2 = createTestRequest(
      "http://localhost:3000/api/variables/USER1_VAR",
    );
    const response2 = await GET(request2);
    expect(response2.status).toBe(200);
  });

  it("should return 404 for user without scope", async () => {
    mockClerk({ userId: `user-no-scope-${Date.now()}` });

    const request = createTestRequest(
      "http://localhost:3000/api/variables/ANY_VAR",
    );
    const response = await GET(request);

    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/variables/:name - Delete Variable", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/variables/TEST_VAR",
      { method: "DELETE" },
    );
    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should delete variable successfully", async () => {
    await createVariable("DELETE_ME_VAR", "to-be-deleted");

    // Verify it exists
    const getRequest = createTestRequest(
      "http://localhost:3000/api/variables/DELETE_ME_VAR",
    );
    const getResponse = await GET(getRequest);
    expect(getResponse.status).toBe(200);

    // Delete it
    const deleteRequest = createTestRequest(
      "http://localhost:3000/api/variables/DELETE_ME_VAR",
      { method: "DELETE" },
    );
    const deleteResponse = await DELETE(deleteRequest);
    expect(deleteResponse.status).toBe(204);

    // Verify it's gone
    const getRequest2 = createTestRequest(
      "http://localhost:3000/api/variables/DELETE_ME_VAR",
    );
    const getResponse2 = await GET(getRequest2);
    expect(getResponse2.status).toBe(404);
  });

  it("should return 404 for nonexistent variable", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/variables/NONEXISTENT_VAR",
      { method: "DELETE" },
    );
    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("NONEXISTENT_VAR");
  });

  it("should return 404 for other user's variable", async () => {
    // Create variable as current user
    await createVariable("USER1_VAR", "user1-value");

    // Switch to other user
    await context.setupUser({ prefix: "other-user" });

    const request = createTestRequest(
      "http://localhost:3000/api/variables/USER1_VAR",
      { method: "DELETE" },
    );
    const response = await DELETE(request);

    // Returns 404 for security (don't leak existence)
    expect(response.status).toBe(404);

    // Switch back to original user and verify it still exists
    mockClerk({ userId: user.userId });
    const getRequest = createTestRequest(
      "http://localhost:3000/api/variables/USER1_VAR",
    );
    const getResponse = await GET(getRequest);
    expect(getResponse.status).toBe(200);
  });

  it("should return 404 for user without scope", async () => {
    mockClerk({ userId: `user-no-scope-${Date.now()}` });

    const request = createTestRequest(
      "http://localhost:3000/api/variables/ANY_VAR",
      { method: "DELETE" },
    );
    const response = await DELETE(request);

    expect(response.status).toBe(404);
  });
});
