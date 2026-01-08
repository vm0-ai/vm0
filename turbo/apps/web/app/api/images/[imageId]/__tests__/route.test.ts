import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { DELETE } from "../route";
import { POST, GET } from "../../route";
import { initServices } from "../../../../../src/lib/init-services";
import { images } from "../../../../../src/db/schema/image";
import { scopes } from "../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { createUserScope } from "../../../../../src/lib/scope/scope-service";

// Mock the auth module
let mockUserId: string | null = "test-user-delete-images";
vi.mock("../../../../../src/lib/auth/get-user-id", () => ({
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
        templateId: "test-template-id",
        buildId: "test-build-id-delete",
      }),
      getBuildStatus: vi.fn().mockResolvedValue({
        status: "building",
        logEntries: ["Building..."],
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

describe("DELETE /api/images/:imageId", () => {
  const testUserId = "test-user-delete-images";
  const testUserId2 = "test-user-delete-images-2";

  beforeAll(async () => {
    initServices();
    // Create scopes for test users (required for image builds)
    await createUserScope(testUserId, `del-test-${Date.now()}`);
    await createUserScope(testUserId2, `del-test2-${Date.now()}`);
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

  it("should delete an existing image", async () => {
    // Create an image first
    const createRequest = new NextRequest("http://localhost:3000/api/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dockerfile: "FROM alpine",
        alias: "delete-me-image",
      }),
    });
    const createResponse = await POST(createRequest);
    const createData = await createResponse.json();
    const imageId = createData.imageId;

    // Delete the image
    const deleteRequest = new NextRequest(
      `http://localhost:3000/api/images/${imageId}`,
      { method: "DELETE" },
    );

    const response = await DELETE(deleteRequest);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.deleted).toBe(true);

    // Verify it's gone
    const listRequest = new NextRequest("http://localhost:3000/api/images", {
      method: "GET",
    });
    const listResponse = await GET(listRequest);
    const listData = await listResponse.json();
    const imageNames = listData.images.map((i: { alias: string }) => i.alias);
    expect(imageNames).not.toContain("delete-me-image");
  });

  it("should return 404 for non-existent image", async () => {
    const fakeImageId = "00000000-0000-0000-0000-000000000000";
    const request = new NextRequest(
      `http://localhost:3000/api/images/${fakeImageId}`,
      { method: "DELETE" },
    );

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("not found");
  });

  it("should not delete another user's image", async () => {
    // Create as user 1
    mockUserId = testUserId;
    const createRequest = new NextRequest("http://localhost:3000/api/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dockerfile: "FROM alpine",
        alias: "user1-private-image",
      }),
    });
    const createResponse = await POST(createRequest);
    const createData = await createResponse.json();
    const imageId = createData.imageId;

    // Try to delete as user 2
    mockUserId = testUserId2;
    const deleteRequest = new NextRequest(
      `http://localhost:3000/api/images/${imageId}`,
      { method: "DELETE" },
    );

    const response = await DELETE(deleteRequest);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.message).toContain("access");

    mockUserId = testUserId;
  });

  it("should require authentication", async () => {
    mockUserId = null;

    const request = new NextRequest(
      "http://localhost:3000/api/images/any-image-id",
      { method: "DELETE" },
    );

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");

    mockUserId = testUserId;
  });
});
