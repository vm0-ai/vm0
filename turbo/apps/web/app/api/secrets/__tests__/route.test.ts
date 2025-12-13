/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST, DELETE } from "../route";
import { initServices } from "../../../../src/lib/init-services";
import { userSecrets } from "../../../../src/db/schema/user-secrets";
import { eq } from "drizzle-orm";

/**
 * Helper to create a NextRequest for testing.
 * Uses actual NextRequest constructor so ts-rest handler gets nextUrl property.
 */
function createTestRequest(
  url: string,
  options?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  },
): NextRequest {
  return new NextRequest(url, {
    method: options?.method ?? "GET",
    headers: options?.headers ?? {},
    body: options?.body,
  });
}

// Mock the auth module
let mockUserId: string | null = "test-user-secrets";
vi.mock("../../../../src/lib/auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

describe("/api/secrets", () => {
  const testUserId = "test-user-secrets";

  beforeAll(() => {
    initServices();
  });

  afterAll(async () => {
    // Cleanup: Delete all test secrets
    await globalThis.services.db
      .delete(userSecrets)
      .where(eq(userSecrets.userId, testUserId));
    await globalThis.services.db
      .delete(userSecrets)
      .where(eq(userSecrets.userId, "test-user-secrets-2"));
  });

  describe("POST /api/secrets", () => {
    it("should create a new secret", async () => {
      const request = createTestRequest("http://localhost:3000/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "TEST_SECRET_CREATE",
          value: "my-secret-value",
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.name).toBe("TEST_SECRET_CREATE");
      expect(data.action).toBe("created");
    });

    it("should update an existing secret", async () => {
      // Create first
      const createRequest = createTestRequest(
        "http://localhost:3000/api/secrets",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "TEST_SECRET_UPDATE",
            value: "initial-value",
          }),
        },
      );
      await POST(createRequest);

      // Update
      const updateRequest = createTestRequest(
        "http://localhost:3000/api/secrets",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "TEST_SECRET_UPDATE",
            value: "updated-value",
          }),
        },
      );

      const response = await POST(updateRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.name).toBe("TEST_SECRET_UPDATE");
      expect(data.action).toBe("updated");
    });

    it("should reject invalid secret names", async () => {
      const invalidNames = [
        "123_STARTS_WITH_NUMBER",
        "has-hyphens",
        "has spaces",
        "has.dots",
        "_STARTS_WITH_UNDERSCORE",
      ];

      for (const name of invalidNames) {
        const request = createTestRequest("http://localhost:3000/api/secrets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, value: "test-value" }),
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error.message).toContain("Invalid secret name");
      }
    });

    it("should accept valid secret names", async () => {
      const validNames = [
        "MY_SECRET",
        "mySecret",
        "MySecret123",
        "A",
        "a_b_c_123",
      ];

      for (const name of validNames) {
        const request = createTestRequest("http://localhost:3000/api/secrets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, value: "test-value" }),
        });

        const response = await POST(request);
        expect(response.status).toBeLessThanOrEqual(201);
      }
    });

    it("should reject secret names longer than 255 characters", async () => {
      const longName = "A".repeat(256);
      const request = createTestRequest("http://localhost:3000/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: longName, value: "test-value" }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("255 characters or less");
    });

    it("should reject secret values larger than 48KB", async () => {
      const largeValue = "x".repeat(49 * 1024); // 49KB
      const request = createTestRequest("http://localhost:3000/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "LARGE_SECRET", value: largeValue }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("48 KB or less");
    });

    it("should reject missing name", async () => {
      const request = createTestRequest("http://localhost:3000/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "test-value" }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Missing or invalid name");
    });

    it("should reject missing value", async () => {
      const request = createTestRequest("http://localhost:3000/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "TEST_NO_VALUE" }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Missing or invalid value");
    });

    it("should require authentication", async () => {
      mockUserId = null;

      const request = createTestRequest("http://localhost:3000/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "TEST_AUTH", value: "test" }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");

      mockUserId = testUserId;
    });
  });

  describe("GET /api/secrets", () => {
    it("should list all secrets for a user", async () => {
      // Create some secrets first
      const secrets = ["LIST_SECRET_1", "LIST_SECRET_2", "LIST_SECRET_3"];
      for (const name of secrets) {
        const request = createTestRequest("http://localhost:3000/api/secrets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, value: "test-value" }),
        });
        await POST(request);
      }

      const getRequest = createTestRequest(
        "http://localhost:3000/api/secrets",
        {
          method: "GET",
        },
      );
      const response = await GET(getRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.secrets).toBeDefined();
      expect(Array.isArray(data.secrets)).toBe(true);

      const secretNames = data.secrets.map((s: { name: string }) => s.name);
      for (const name of secrets) {
        expect(secretNames).toContain(name);
      }
    });

    it("should not return secret values", async () => {
      const getRequest = createTestRequest(
        "http://localhost:3000/api/secrets",
        {
          method: "GET",
        },
      );
      const response = await GET(getRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      for (const secret of data.secrets) {
        expect(secret.value).toBeUndefined();
        expect(secret.encryptedValue).toBeUndefined();
      }
    });

    it("should only return secrets for the authenticated user", async () => {
      // Create secret as user 1
      mockUserId = testUserId;
      const request1 = createTestRequest("http://localhost:3000/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "USER1_SECRET", value: "user1-value" }),
      });
      await POST(request1);

      // Create secret as user 2
      mockUserId = "test-user-secrets-2";
      const request2 = createTestRequest("http://localhost:3000/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "USER2_SECRET", value: "user2-value" }),
      });
      await POST(request2);

      // List as user 2 - should not see user 1's secrets
      const getRequest = createTestRequest(
        "http://localhost:3000/api/secrets",
        {
          method: "GET",
        },
      );
      const response = await GET(getRequest);
      const data = await response.json();

      const secretNames = data.secrets.map((s: { name: string }) => s.name);
      expect(secretNames).toContain("USER2_SECRET");
      expect(secretNames).not.toContain("USER1_SECRET");

      mockUserId = testUserId;
    });

    it("should require authentication", async () => {
      mockUserId = null;

      const getRequest = createTestRequest(
        "http://localhost:3000/api/secrets",
        {
          method: "GET",
        },
      );
      const response = await GET(getRequest);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");

      mockUserId = testUserId;
    });
  });

  describe("DELETE /api/secrets", () => {
    it("should delete an existing secret", async () => {
      // Create first
      const createRequest = createTestRequest(
        "http://localhost:3000/api/secrets",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "DELETE_ME", value: "to-be-deleted" }),
        },
      );
      await POST(createRequest);

      // Delete
      const deleteRequest = createTestRequest(
        "http://localhost:3000/api/secrets?name=DELETE_ME",
        { method: "DELETE" },
      );

      const response = await DELETE(deleteRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.name).toBe("DELETE_ME");
      expect(data.deleted).toBe(true);

      // Verify it's gone
      const listRequest = createTestRequest(
        "http://localhost:3000/api/secrets",
        {
          method: "GET",
        },
      );
      const listResponse = await GET(listRequest);
      const listData = await listResponse.json();
      const secretNames = listData.secrets.map((s: { name: string }) => s.name);
      expect(secretNames).not.toContain("DELETE_ME");
    });

    it("should return 404 for non-existent secret", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/secrets?name=NONEXISTENT_SECRET",
        { method: "DELETE" },
      );

      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("Secret not found");
    });

    it("should require name parameter", async () => {
      const request = createTestRequest("http://localhost:3000/api/secrets", {
        method: "DELETE",
      });

      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Missing name query parameter");
    });

    it("should not delete another user's secret", async () => {
      // Create as user 1
      mockUserId = testUserId;
      const createRequest = createTestRequest(
        "http://localhost:3000/api/secrets",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "USER1_ONLY", value: "private" }),
        },
      );
      await POST(createRequest);

      // Try to delete as user 2
      mockUserId = "test-user-secrets-2";
      const deleteRequest = createTestRequest(
        "http://localhost:3000/api/secrets?name=USER1_ONLY",
        { method: "DELETE" },
      );

      const response = await DELETE(deleteRequest);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("Secret not found");

      mockUserId = testUserId;
    });

    it("should require authentication", async () => {
      mockUserId = null;

      const request = createTestRequest(
        "http://localhost:3000/api/secrets?name=ANY_SECRET",
        { method: "DELETE" },
      );

      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");

      mockUserId = testUserId;
    });
  });
});
