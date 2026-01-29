import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET as listVolumes } from "../route";
import { GET as getVolume } from "../[id]/route";
import { GET as listVersions } from "../[id]/versions/route";
import {
  createTestRequest,
  createTestVolume,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");

const context = testContext();

describe("Public API v1 - Volumes Endpoints", () => {
  let testVolumeName: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    // Create a test volume using API helper
    testVolumeName = `test-volume-${Date.now()}`;
    await createTestVolume(testVolumeName);
  });

  /**
   * Helper to get volume ID from name via list endpoint.
   * This is needed because the createTestVolume helper doesn't return the storage ID.
   */
  async function getVolumeIdByName(name: string): Promise<string | undefined> {
    const request = createTestRequest("http://localhost:3000/v1/volumes");
    const response = await listVolumes(request);
    const data = await response.json();
    const volume = data.data.find((v: { name: string }) => v.name === name) as
      | { id: string }
      | undefined;
    return volume?.id;
  }

  describe("GET /v1/volumes - List Volumes", () => {
    it("should list volumes with pagination", async () => {
      const request = createTestRequest("http://localhost:3000/v1/volumes");

      const response = await listVolumes(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.pagination).toBeDefined();
      expect(data.pagination.hasMore).toBeDefined();
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
      const testVolumeId = await getVolumeIdByName(testVolumeName);
      expect(testVolumeId).toBeDefined();

      const request = createTestRequest(
        `http://localhost:3000/v1/volumes/${testVolumeId}`,
      );

      const response = await getVolume(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testVolumeId);
      expect(data.name).toBe(testVolumeName);
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
    it("should list volume versions", async () => {
      const testVolumeId = await getVolumeIdByName(testVolumeName);
      expect(testVolumeId).toBeDefined();

      const request = createTestRequest(
        `http://localhost:3000/v1/volumes/${testVolumeId}/versions`,
      );

      const response = await listVersions(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      // createTestVolume creates one version
      expect(data.data.length).toBeGreaterThanOrEqual(1);
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
