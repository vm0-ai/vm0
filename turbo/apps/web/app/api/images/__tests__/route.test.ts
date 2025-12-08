/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { initServices } from "../../../../src/lib/init-services";
import { images } from "../../../../src/db/schema/image";
import { eq } from "drizzle-orm";

// Mock the auth module
let mockUserId: string | null = "test-user-images";
vi.mock("../../../../src/lib/auth/get-user-id", () => ({
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
        buildId: "test-build-id",
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

describe("/api/images", () => {
  const testUserId = "test-user-images";
  const testUserId2 = "test-user-images-2";

  beforeAll(() => {
    initServices();
  });

  afterAll(async () => {
    // Cleanup: Delete all test images
    await globalThis.services.db
      .delete(images)
      .where(eq(images.userId, testUserId));
    await globalThis.services.db
      .delete(images)
      .where(eq(images.userId, testUserId2));
  });

  describe("POST /api/images", () => {
    it("should start an image build", async () => {
      const request = new Request("http://localhost:3000/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dockerfile: "FROM alpine\nRUN echo hello",
          alias: "test-image-build",
        }),
      });

      const response = await POST(request as NextRequest);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.buildId).toBe("test-build-id");
      expect(data.alias).toBe("test-image-build");
      expect(data.imageId).toBeDefined();
    });

    it("should reject missing dockerfile", async () => {
      const request = new Request("http://localhost:3000/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alias: "test-no-dockerfile",
        }),
      });

      const response = await POST(request as NextRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Missing dockerfile");
    });

    it("should reject missing alias", async () => {
      const request = new Request("http://localhost:3000/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dockerfile: "FROM alpine",
        }),
      });

      const response = await POST(request as NextRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Missing alias");
    });

    it("should reject alias that is too short", async () => {
      const request = new Request("http://localhost:3000/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dockerfile: "FROM alpine",
          alias: "ab",
        }),
      });

      const response = await POST(request as NextRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Invalid alias format");
    });

    it("should reject alias with invalid characters", async () => {
      const request = new Request("http://localhost:3000/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dockerfile: "FROM alpine",
          alias: "test_image",
        }),
      });

      const response = await POST(request as NextRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Invalid alias format");
    });

    it("should reject alias starting with hyphen", async () => {
      const request = new Request("http://localhost:3000/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dockerfile: "FROM alpine",
          alias: "-invalid",
        }),
      });

      const response = await POST(request as NextRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Invalid alias format");
    });

    it("should reject reserved vm0- prefix", async () => {
      const request = new Request("http://localhost:3000/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dockerfile: "FROM alpine",
          alias: "vm0-custom",
        }),
      });

      const response = await POST(request as NextRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("vm0-");
    });

    it("should require authentication", async () => {
      mockUserId = null;

      const request = new Request("http://localhost:3000/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dockerfile: "FROM alpine",
          alias: "test-auth",
        }),
      });

      const response = await POST(request as NextRequest);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");

      mockUserId = testUserId;
    });
  });

  describe("GET /api/images", () => {
    it("should list user images", async () => {
      // Create an image first
      const createRequest = new Request("http://localhost:3000/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dockerfile: "FROM alpine",
          alias: "list-test-image",
        }),
      });
      await POST(createRequest as NextRequest);

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.images).toBeDefined();
      expect(Array.isArray(data.images)).toBe(true);

      const imageNames = data.images.map((i: { alias: string }) => i.alias);
      expect(imageNames).toContain("list-test-image");
    });

    it("should only return images for the authenticated user", async () => {
      // Create image as user 1
      mockUserId = testUserId;
      const request1 = new Request("http://localhost:3000/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dockerfile: "FROM alpine",
          alias: "user1-image",
        }),
      });
      await POST(request1 as NextRequest);

      // Create image as user 2
      mockUserId = testUserId2;
      const request2 = new Request("http://localhost:3000/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dockerfile: "FROM alpine",
          alias: "user2-image",
        }),
      });
      await POST(request2 as NextRequest);

      // List as user 2 - should not see user 1's images
      const response = await GET();
      const data = await response.json();

      const imageNames = data.images.map((i: { alias: string }) => i.alias);
      expect(imageNames).toContain("user2-image");
      expect(imageNames).not.toContain("user1-image");

      mockUserId = testUserId;
    });

    it("should require authentication", async () => {
      mockUserId = null;

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");

      mockUserId = testUserId;
    });
  });
});
