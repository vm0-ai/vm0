import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET as listAgents } from "../route";
import { GET as getAgent } from "../[id]/route";
import { GET as listVersions } from "../[id]/versions/route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");

const context = testContext();

describe("Public API v1 - Agents Endpoints", () => {
  let testAgentId: string;
  const testAgentName = `test-agent-v1-${Date.now()}`;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    // Create a test agent using API helper
    const { composeId } = await createTestCompose(testAgentName);
    testAgentId = composeId;
  });

  describe("GET /v1/agents - List Agents", () => {
    it("should list agents with pagination", async () => {
      const request = createTestRequest("http://localhost:3000/v1/agents");

      const response = await listAgents(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.pagination).toBeDefined();
      expect(data.pagination.hasMore).toBe(false);
    });

    it("should support limit parameter", async () => {
      const request = createTestRequest(
        "http://localhost:3000/v1/agents?limit=1",
      );

      const response = await listAgents(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.length).toBeLessThanOrEqual(1);
    });

    it("should filter by name when name parameter provided", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/agents?name=${testAgentName}`,
      );

      const response = await listAgents(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data.length).toBe(1);
      expect(data.data[0].name).toBe(testAgentName);
      expect(data.pagination.hasMore).toBe(false);
    });

    it("should return empty array when name not found", async () => {
      const request = createTestRequest(
        "http://localhost:3000/v1/agents?name=nonexistent-agent",
      );

      const response = await listAgents(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data.length).toBe(0);
      expect(data.pagination.hasMore).toBe(false);
      expect(data.pagination.nextCursor).toBeNull();
    });

    it("should filter by name case-insensitively", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/agents?name=${testAgentName.toUpperCase()}`,
      );

      const response = await listAgents(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data.length).toBe(1);
      expect(data.data[0].name).toBe(testAgentName);
    });

    it("should filter by name combined with limit", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/agents?name=${testAgentName}&limit=10`,
      );

      const response = await listAgents(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data.length).toBe(1);
      expect(data.data[0].name).toBe(testAgentName);
    });

    it("should return 401 for unauthenticated request", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest("http://localhost:3000/v1/agents");

      const response = await listAgents(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.type).toBe("authentication_error");
    });
  });

  describe("GET /v1/agents/:id - Get Agent", () => {
    it("should get agent by ID", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/agents/${testAgentId}`,
      );

      const response = await getAgent(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testAgentId);
      expect(data.name).toBe(testAgentName);
    });

    it("should return 404 for non-existent agent", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/agents/${fakeId}`,
      );

      const response = await getAgent(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");
      expect(data.error.code).toBe("resource_not_found");
    });
  });

  describe("GET /v1/agents/:id/versions - List Agent Versions", () => {
    it("should list agent versions", async () => {
      // Create a fresh compose for this test to ensure version exists
      const versionsAgentName = `versions-agent-${Date.now()}`;
      const { composeId } = await createTestCompose(versionsAgentName);

      const request = createTestRequest(
        `http://localhost:3000/v1/agents/${composeId}/versions`,
      );

      const response = await listVersions(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data.length).toBeGreaterThan(0);
      expect(data.pagination).toBeDefined();

      // Each version should have required fields
      const version = data.data[0];
      expect(version.id).toBeDefined();
      expect(version.agentId).toBe(composeId);
      expect(version.versionNumber).toBeDefined();
      expect(version.createdAt).toBeDefined();
    });

    it("should return 404 for non-existent agent", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/agents/${fakeId}/versions`,
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
        `http://localhost:3000/v1/agents/${fakeId}`,
      );

      const response = await getAgent(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBeDefined();
      expect(data.error.type).toBe("not_found_error");
      expect(data.error.code).toBe("resource_not_found");
      expect(data.error.message).toContain(fakeId);
    });
  });
});
