import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import { NextRequest } from "next/server";
import { GET as listVolumes } from "../route";
import { GET as getVolume } from "../[id]/route";
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

// Mock Clerk auth (external SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

import {
  mockClerk,
  clearClerkMock,
} from "../../../../src/__tests__/clerk-mock";

describe("Public API v1 - Volumes Endpoints", () => {
  const testUserId = "test-user-volumes-api";
  const testScopeId = randomUUID();
  let testVolumeId: string;

  beforeAll(async () => {
    initServices();

    // Clean up any existing test data
    await globalThis.services.db
      .delete(storages)
      .where(and(eq(storages.userId, testUserId), eq(storages.type, "volume")));

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

    // Create test volume directly in database
    const [created] = await globalThis.services.db
      .insert(storages)
      .values({
        userId: testUserId,
        name: "test-volume-v1",
        type: "volume",
        s3Prefix: `${testUserId}/volume/test-volume-v1`,
      })
      .returning();

    testVolumeId = created!.id;
  });

  beforeEach(() => {
    // Mock Clerk auth to return test user by default
    mockClerk({ userId: testUserId });
  });

  afterEach(() => {
    clearClerkMock();
  });

  afterAll(async () => {
    // Cleanup: Delete test data
    await globalThis.services.db
      .delete(storages)
      .where(and(eq(storages.userId, testUserId), eq(storages.type, "volume")));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  describe("GET /v1/volumes - List Volumes", () => {
    it("should list volumes with pagination", async () => {
      const request = createTestRequest("http://localhost:3000/v1/volumes");

      const response = await listVolumes(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.pagination).toBeDefined();
      expect(data.pagination.has_more).toBeDefined();
    });

    it("should support limit parameter", async () => {
      const request = createTestRequest(
        "http://localhost:3000/v1/volumes?limit=1",
      );

      const response = await listVolumes(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.length).toBeLessThanOrEqual(1);
    });

    it("should return 401 for unauthenticated request", async () => {
      // Mock Clerk to return no user
      mockClerk({ userId: null });

      const request = createTestRequest("http://localhost:3000/v1/volumes");

      const response = await listVolumes(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.type).toBe("authentication_error");
    });
  });

  describe("GET /v1/volumes/:id - Get Volume", () => {
    it("should get volume by ID", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/volumes/${testVolumeId}`,
      );

      const response = await getVolume(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testVolumeId);
      expect(data.name).toBe("test-volume-v1");
      expect(data.current_version).toBeNull();
    });

    it("should return 404 for non-existent volume", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/volumes/${fakeId}`,
      );

      const response = await getVolume(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");
      expect(data.error.code).toBe("resource_not_found");
    });
  });

  describe("GET /v1/volumes/:id/versions - List Volume Versions", () => {
    it("should list volume versions (empty)", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/volumes/${testVolumeId}/versions`,
      );

      const response = await listVersions(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data.length).toBe(0);
      expect(data.pagination).toBeDefined();
    });

    it("should return 404 for non-existent volume", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/volumes/${fakeId}/versions`,
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
        `http://localhost:3000/v1/volumes/${fakeId}`,
      );

      const response = await getVolume(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBeDefined();
      expect(data.error.type).toBe("not_found_error");
      expect(data.error.code).toBe("resource_not_found");
      expect(data.error.message).toContain(fakeId);
    });
  });
});
