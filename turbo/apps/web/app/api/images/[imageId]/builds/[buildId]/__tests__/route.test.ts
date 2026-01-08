import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { POST } from "../../../../route";
import { initServices } from "../../../../../../../src/lib/init-services";
import { images } from "../../../../../../../src/db/schema/image";
import { scopes } from "../../../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { createUserScope } from "../../../../../../../src/lib/scope/scope-service";

// Mock the auth module
let mockUserId: string | null = "test-user-nested-builds";
vi.mock("../../../../../../../src/lib/auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

// Mock E2B Template
vi.mock("e2b", () => ({
  Template: Object.assign(
    () => ({
      fromDockerfile: (dockerfile: string) => ({ dockerfile }),
    }),
    {
      buildInBackground: vi.fn().mockResolvedValue({
        templateId: "test-template-id-nested",
        buildId: "test-build-id-nested",
      }),
      getBuildStatus: vi.fn().mockResolvedValue({
        status: "building",
        logEntries: [
          {
            message: "Building layer 1...",
            level: "info",
            timestamp: new Date().toISOString(),
          },
        ],
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  ),
  BuildError: class BuildError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "BuildError";
    }
  },
  ApiClient: vi.fn().mockImplementation(() => ({
    api: {
      GET: vi.fn().mockResolvedValue({ data: [] }),
      DELETE: vi.fn().mockResolvedValue(undefined),
    },
  })),
  ConnectionConfig: vi.fn(),
}));

describe("GET /api/images/:imageId/builds/:buildId", () => {
  const testUserId = "test-user-nested-builds";
  const testUserId2 = "test-user-nested-builds-2";
  let testImageId: string;
  let testBuildId: string;

  beforeAll(async () => {
    initServices();

    // Create scopes for test users (required for image builds)
    await createUserScope(testUserId, `build-test-${Date.now()}`);
    await createUserScope(testUserId2, `build-test2-${Date.now()}`);

    // Create an image for testing
    const createRequest = new NextRequest("http://localhost:3000/api/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dockerfile: "FROM alpine",
        alias: "nested-build-test",
      }),
    });
    const createResponse = await POST(createRequest);
    const createData = await createResponse.json();
    testImageId = createData.imageId;
    testBuildId = createData.buildId;
  });

  afterAll(async () => {
    // Cleanup: Delete all test images
    await globalThis.services.db
      .delete(images)
      .where(eq(images.userId, testUserId));
    await globalThis.services.db
      .delete(images)
      .where(eq(images.userId, testUserId2));
    // Cleanup: Delete test scopes
    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.ownerId, testUserId));
    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.ownerId, testUserId2));
  });

  it("should return build status with logs", async () => {
    const request = new NextRequest(
      `http://localhost:3000/api/images/${testImageId}/builds/${testBuildId}?logsOffset=0`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("building");
    expect(data.logs).toBeDefined();
    expect(Array.isArray(data.logs)).toBe(true);
    expect(data.logsOffset).toBeDefined();
  });

  it("should return 404 for non-existent image", async () => {
    const request = new NextRequest(
      `http://localhost:3000/api/images/00000000-0000-0000-0000-000000000000/builds/${testBuildId}`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("not found");
  });

  it("should return 404 for mismatched buildId", async () => {
    const request = new NextRequest(
      `http://localhost:3000/api/images/${testImageId}/builds/wrong-build-id`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("not found");
  });

  it("should not return status for another user's image", async () => {
    // The testImageId was created by testUserId in beforeAll
    // Try to get status as user 2
    mockUserId = testUserId2;
    const request = new NextRequest(
      `http://localhost:3000/api/images/${testImageId}/builds/${testBuildId}`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("access");

    // Reset to testUserId
    mockUserId = testUserId;
  });

  it("should reject invalid logsOffset", async () => {
    const request = new NextRequest(
      `http://localhost:3000/api/images/${testImageId}/builds/${testBuildId}?logsOffset=-1`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("logsOffset");
  });

  it("should require authentication", async () => {
    mockUserId = null;

    const request = new NextRequest(
      `http://localhost:3000/api/images/${testImageId}/builds/${testBuildId}`,
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");

    mockUserId = testUserId;
  });
});
