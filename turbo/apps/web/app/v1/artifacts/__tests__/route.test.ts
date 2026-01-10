import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as listArtifacts, POST as createArtifact } from "../route";
import { GET as getArtifact } from "../[id]/route";
import { GET as listVersions } from "../[id]/versions/route";
import { initServices } from "../../../../src/lib/init-services";
import { storages } from "../../../../src/db/schema/storage";
import { scopes } from "../../../../src/db/schema/scope";
import { eq, and } from "drizzle-orm";
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
let mockUserId = "test-user-artifacts-api";
vi.mock("../../../../src/lib/auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

describe("Public API v1 - Artifacts Endpoints", () => {
  const testUserId = "test-user-artifacts-api";
  const testScopeId = randomUUID();
  let testArtifactId: string;

  beforeAll(async () => {
    initServices();

    // Clean up any existing test data
    await globalThis.services.db
      .delete(storages)
      .where(
        and(eq(storages.userId, testUserId), eq(storages.type, "artifact")),
      );

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));

    // Create test scope for the user
    await globalThis.services.db.insert(scopes).values({
      id: testScopeId,
      slug: `test-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
    });
  });

  afterAll(async () => {
    // Cleanup: Delete test data
    await globalThis.services.db
      .delete(storages)
      .where(
        and(eq(storages.userId, testUserId), eq(storages.type, "artifact")),
      );

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  describe("POST /v1/artifacts - Create Artifact", () => {
    it("should create a new artifact", async () => {
      const request = createTestRequest("http://localhost:3000/v1/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test-artifact-v1",
        }),
      });

      const response = await createArtifact(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.id).toBeDefined();
      expect(data.name).toBe("test-artifact-v1");
      expect(data.current_version_id).toBeNull();
      expect(data.size).toBe(0);
      expect(data.file_count).toBe(0);
      expect(data.created_at).toBeDefined();
      expect(data.updated_at).toBeDefined();

      testArtifactId = data.id;
    });

    it("should return 409 when artifact already exists", async () => {
      const request = createTestRequest("http://localhost:3000/v1/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test-artifact-v1",
        }),
      });

      const response = await createArtifact(request);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error.type).toBe("conflict_error");
      expect(data.error.code).toBe("resource_already_exists");
    });

    it("should return 401 for unauthenticated request", async () => {
      mockUserId = "";

      const request = createTestRequest("http://localhost:3000/v1/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test-artifact-unauth",
        }),
      });

      const response = await createArtifact(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.type).toBe("authentication_error");

      mockUserId = testUserId;
    });
  });

  describe("GET /v1/artifacts - List Artifacts", () => {
    it("should list artifacts with pagination", async () => {
      const request = createTestRequest("http://localhost:3000/v1/artifacts");

      const response = await listArtifacts(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.pagination).toBeDefined();
      expect(data.pagination.has_more).toBeDefined();
    });

    it("should support limit parameter", async () => {
      const request = createTestRequest(
        "http://localhost:3000/v1/artifacts?limit=1",
      );

      const response = await listArtifacts(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.length).toBeLessThanOrEqual(1);
    });
  });

  describe("GET /v1/artifacts/:id - Get Artifact", () => {
    it("should get artifact by ID", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/artifacts/${testArtifactId}`,
      );

      const response = await getArtifact(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testArtifactId);
      expect(data.name).toBe("test-artifact-v1");
      expect(data.current_version).toBeNull();
    });

    it("should return 404 for non-existent artifact", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/artifacts/${fakeId}`,
      );

      const response = await getArtifact(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");
      expect(data.error.code).toBe("resource_not_found");
    });
  });

  describe("GET /v1/artifacts/:id/versions - List Artifact Versions", () => {
    it("should list artifact versions (empty)", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/artifacts/${testArtifactId}/versions`,
      );

      const response = await listVersions(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data.length).toBe(0);
      expect(data.pagination).toBeDefined();
    });

    it("should return 404 for non-existent artifact", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/artifacts/${fakeId}/versions`,
      );

      const response = await listVersions(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");
    });
  });

  describe("Error Response Format", () => {
    it("should return Stripe-style error format", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/artifacts/${fakeId}`,
      );

      const response = await getArtifact(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBeDefined();
      expect(data.error.type).toBe("not_found_error");
      expect(data.error.code).toBe("resource_not_found");
      expect(data.error.message).toContain(fakeId);
    });
  });
});
