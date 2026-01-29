import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET as listArtifacts } from "../route";
import { GET as getArtifact } from "../[id]/route";
import { GET as listVersions } from "../[id]/versions/route";
import {
  createTestRequest,
  createTestArtifact,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");

const context = testContext();

describe("Public API v1 - Artifacts Endpoints", () => {
  let testArtifactName: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    // Create a test artifact using API helper
    testArtifactName = `test-artifact-${Date.now()}`;
    await createTestArtifact(testArtifactName);
  });

  /**
   * Helper to get artifact ID from name via list endpoint.
   * This is needed because the createTestArtifact helper doesn't return the storage ID.
   */
  async function getArtifactIdByName(
    name: string,
  ): Promise<string | undefined> {
    const request = createTestRequest("http://localhost:3000/v1/artifacts");
    const response = await listArtifacts(request);
    const data = await response.json();
    const artifact = data.data.find(
      (a: { name: string }) => a.name === name,
    ) as { id: string } | undefined;
    return artifact?.id;
  }

  describe("GET /v1/artifacts - List Artifacts", () => {
    it("should list artifacts with pagination", async () => {
      const request = createTestRequest("http://localhost:3000/v1/artifacts");

      const response = await listArtifacts(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.pagination).toBeDefined();
      expect(data.pagination.hasMore).toBeDefined();
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

    it("should return 401 for unauthenticated request", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest("http://localhost:3000/v1/artifacts");

      const response = await listArtifacts(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.type).toBe("authentication_error");
    });
  });

  describe("GET /v1/artifacts/:id - Get Artifact", () => {
    it("should get artifact by ID", async () => {
      const testArtifactId = await getArtifactIdByName(testArtifactName);
      expect(testArtifactId).toBeDefined();

      const request = createTestRequest(
        `http://localhost:3000/v1/artifacts/${testArtifactId}`,
      );

      const response = await getArtifact(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testArtifactId);
      expect(data.name).toBe(testArtifactName);
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
    it("should list artifact versions", async () => {
      const testArtifactId = await getArtifactIdByName(testArtifactName);
      expect(testArtifactId).toBeDefined();

      const request = createTestRequest(
        `http://localhost:3000/v1/artifacts/${testArtifactId}/versions`,
      );

      const response = await listVersions(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      // createTestArtifact creates one version
      expect(data.data.length).toBeGreaterThanOrEqual(1);
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
