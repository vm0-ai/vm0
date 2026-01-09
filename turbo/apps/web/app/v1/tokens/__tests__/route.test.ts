import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as listTokens, POST as createToken } from "../route";
import { GET as getToken, DELETE as deleteToken } from "../[id]/route";
import { initServices } from "../../../../src/lib/init-services";
import { cliTokens } from "../../../../src/db/schema/cli-tokens";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

/**
 * Helper to create a NextRequest for testing.
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
let mockUserId = "test-user-tokens-api";
vi.mock("../../../../src/lib/auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

describe("Public API v1 - Tokens Endpoints", () => {
  const testUserId = "test-user-tokens-api";
  let createdTokenId: string;

  beforeAll(async () => {
    initServices();

    // Clean up any existing test data
    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.userId, testUserId));
  });

  afterAll(async () => {
    // Cleanup: Delete test data
    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.userId, testUserId));
  });

  describe("POST /v1/tokens - Create Token", () => {
    it("should create a new token", async () => {
      const request = createTestRequest("http://localhost:3000/v1/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Token",
          expires_in_days: 30,
        }),
      });

      const response = await createToken(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.id).toBeDefined();
      expect(data.name).toBe("Test Token");
      expect(data.token).toBeDefined();
      expect(data.token).toMatch(/^vm0_live_[a-f0-9]+$/);
      expect(data.token_prefix).toBeDefined();
      expect(data.expires_at).toBeDefined();
      expect(data.created_at).toBeDefined();

      createdTokenId = data.id;
    });

    it("should create token with default expiry", async () => {
      const request = createTestRequest("http://localhost:3000/v1/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Default Expiry Token",
        }),
      });

      const response = await createToken(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.name).toBe("Default Expiry Token");

      // Default expiry is 90 days
      const expiresAt = new Date(data.expires_at);
      const now = new Date();
      const diffDays = Math.floor(
        (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBeGreaterThanOrEqual(89);
      expect(diffDays).toBeLessThanOrEqual(91);
    });

    it("should return 401 for unauthenticated request", async () => {
      mockUserId = "";

      const request = createTestRequest("http://localhost:3000/v1/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Unauthorized Token",
        }),
      });

      const response = await createToken(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.type).toBe("authentication_error");

      mockUserId = testUserId;
    });
  });

  describe("GET /v1/tokens - List Tokens", () => {
    it("should list user tokens", async () => {
      const request = createTestRequest("http://localhost:3000/v1/tokens");

      const response = await listTokens(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeDefined();
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThanOrEqual(1);
      expect(data.pagination).toBeDefined();

      // Token value should NOT be included in list response
      expect(data.data[0].token).toBeUndefined();
      expect(data.data[0].token_prefix).toBeDefined();
    });

    it("should support pagination with limit", async () => {
      const request = createTestRequest(
        "http://localhost:3000/v1/tokens?limit=1",
      );

      const response = await listTokens(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.length).toBe(1);
      expect(data.pagination.has_more).toBe(true);
    });

    it("should return 401 for unauthenticated request", async () => {
      mockUserId = "";

      const request = createTestRequest("http://localhost:3000/v1/tokens");

      const response = await listTokens(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.type).toBe("authentication_error");

      mockUserId = testUserId;
    });
  });

  describe("GET /v1/tokens/:id - Get Token", () => {
    it("should get token details", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/tokens/${createdTokenId}`,
      );

      const response = await getToken(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(createdTokenId);
      expect(data.name).toBe("Test Token");
      expect(data.token_prefix).toBeDefined();
      // Token value should NOT be included
      expect(data.token).toBeUndefined();
    });

    it("should return 404 for non-existent token", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/tokens/${fakeId}`,
      );

      const response = await getToken(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");
      expect(data.error.code).toBe("resource_not_found");
    });

    it("should return 404 for other user token", async () => {
      // Create a token for another user
      const otherUserId = "other-user-id";
      const otherToken = await globalThis.services.db
        .insert(cliTokens)
        .values({
          token: `vm0_live_${randomUUID().replace(/-/g, "")}`,
          userId: otherUserId,
          name: "Other User Token",
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        })
        .returning();

      const request = createTestRequest(
        `http://localhost:3000/v1/tokens/${otherToken[0]!.id}`,
      );

      const response = await getToken(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");

      // Cleanup
      await globalThis.services.db
        .delete(cliTokens)
        .where(eq(cliTokens.userId, otherUserId));
    });
  });

  describe("DELETE /v1/tokens/:id - Revoke Token", () => {
    it("should delete token", async () => {
      // Create a token to delete
      const tokenRequest = createTestRequest(
        "http://localhost:3000/v1/tokens",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Token to Delete",
          }),
        },
      );

      const createResponse = await createToken(tokenRequest);
      const createdData = await createResponse.json();
      const tokenToDeleteId = createdData.id;

      // Delete the token
      const deleteRequest = createTestRequest(
        `http://localhost:3000/v1/tokens/${tokenToDeleteId}`,
        { method: "DELETE" },
      );

      const deleteResponse = await deleteToken(deleteRequest);

      expect(deleteResponse.status).toBe(204);

      // Verify it's gone
      const getRequest = createTestRequest(
        `http://localhost:3000/v1/tokens/${tokenToDeleteId}`,
      );

      const getResponse = await getToken(getRequest);

      expect(getResponse.status).toBe(404);
    });

    it("should return 404 for non-existent token", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/tokens/${fakeId}`,
        { method: "DELETE" },
      );

      const response = await deleteToken(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");
    });
  });

  describe("Error Response Format", () => {
    it("should return Stripe-style error format", async () => {
      mockUserId = "";

      const request = createTestRequest("http://localhost:3000/v1/tokens");
      const response = await listTokens(request);
      const data = await response.json();

      expect(data.error).toBeDefined();
      expect(data.error.type).toBeDefined();
      expect(data.error.code).toBeDefined();
      expect(data.error.message).toBeDefined();

      mockUserId = testUserId;
    });
  });
});
