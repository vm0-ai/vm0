import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, DELETE } from "../route";
import { PUT } from "../../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

/**
 * Helper to create a credential for testing
 */
async function createCredential(
  name: string,
  value: string,
  description?: string,
): Promise<{ id: string; name: string }> {
  const request = createTestRequest("http://localhost:3000/api/credentials", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, value, description }),
  });
  const response = await PUT(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to create credential: ${error.error?.message}`);
  }
  return response.json();
}

describe("GET /api/credentials/:name - Get Credential", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/credentials/TEST_KEY",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return credential metadata by name", async () => {
    await createCredential("MY_SECRET_KEY", "secret-value", "My secret");

    const request = createTestRequest(
      "http://localhost:3000/api/credentials/MY_SECRET_KEY",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.name).toBe("MY_SECRET_KEY");
    expect(data.description).toBe("My secret");
    expect(data.id).toBeDefined();
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
    expect(data).not.toHaveProperty("value");
    expect(data).not.toHaveProperty("encryptedValue");
  });

  it("should return 404 for nonexistent credential", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/credentials/NONEXISTENT_KEY",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("NONEXISTENT_KEY");
  });

  it("should return 404 for other user's credential", async () => {
    // Create credential as current user
    await createCredential("USER1_KEY", "user1-secret");

    // Switch to other user
    await context.setupUser({ prefix: "other-user" });

    const request = createTestRequest(
      "http://localhost:3000/api/credentials/USER1_KEY",
    );
    const response = await GET(request);

    // Returns 404 for security (don't leak existence)
    expect(response.status).toBe(404);

    // Switch back to original user and verify it still exists
    mockClerk({ userId: user.userId });
    const request2 = createTestRequest(
      "http://localhost:3000/api/credentials/USER1_KEY",
    );
    const response2 = await GET(request2);
    expect(response2.status).toBe(200);
  });

  it("should return 404 for user without scope", async () => {
    mockClerk({ userId: `user-no-scope-${Date.now()}` });

    const request = createTestRequest(
      "http://localhost:3000/api/credentials/ANY_KEY",
    );
    const response = await GET(request);

    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/credentials/:name - Delete Credential", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/credentials/TEST_KEY",
      { method: "DELETE" },
    );
    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should delete credential successfully", async () => {
    await createCredential("DELETE_ME_KEY", "to-be-deleted");

    // Verify it exists
    const getRequest = createTestRequest(
      "http://localhost:3000/api/credentials/DELETE_ME_KEY",
    );
    const getResponse = await GET(getRequest);
    expect(getResponse.status).toBe(200);

    // Delete it
    const deleteRequest = createTestRequest(
      "http://localhost:3000/api/credentials/DELETE_ME_KEY",
      { method: "DELETE" },
    );
    const deleteResponse = await DELETE(deleteRequest);
    expect(deleteResponse.status).toBe(204);

    // Verify it's gone
    const getRequest2 = createTestRequest(
      "http://localhost:3000/api/credentials/DELETE_ME_KEY",
    );
    const getResponse2 = await GET(getRequest2);
    expect(getResponse2.status).toBe(404);
  });

  it("should return 404 for nonexistent credential", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/credentials/NONEXISTENT_KEY",
      { method: "DELETE" },
    );
    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("NONEXISTENT_KEY");
  });

  it("should return 404 for other user's credential", async () => {
    // Create credential as current user
    await createCredential("USER1_SECRET", "user1-value");

    // Switch to other user
    await context.setupUser({ prefix: "other-user" });

    const request = createTestRequest(
      "http://localhost:3000/api/credentials/USER1_SECRET",
      { method: "DELETE" },
    );
    const response = await DELETE(request);

    // Returns 404 for security (don't leak existence)
    expect(response.status).toBe(404);

    // Switch back to original user and verify it still exists
    mockClerk({ userId: user.userId });
    const getRequest = createTestRequest(
      "http://localhost:3000/api/credentials/USER1_SECRET",
    );
    const getResponse = await GET(getRequest);
    expect(getResponse.status).toBe(200);
  });

  it("should return 404 for user without scope", async () => {
    mockClerk({ userId: `user-no-scope-${Date.now()}` });

    const request = createTestRequest(
      "http://localhost:3000/api/credentials/ANY_KEY",
      { method: "DELETE" },
    );
    const response = await DELETE(request);

    expect(response.status).toBe(404);
  });
});
