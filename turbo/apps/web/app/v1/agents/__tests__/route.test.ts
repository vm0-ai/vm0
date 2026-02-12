import { describe, it, expect, beforeEach } from "vitest";
import { GET as listAgents } from "../route";
import { GET as getAgent } from "../[id]/route";
import { GET as listVersions } from "../[id]/versions/route";
import {
  createTestRequest,
  createTestCompose,
  createTestPermission,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import {
  mockClerk,
  MOCK_USER_EMAIL,
} from "../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

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
      // Use name filter for deterministic results (avoids shared agent interference)
      const request = createTestRequest(
        `http://localhost:3000/v1/agents?name=${testAgentName}`,
      );

      const response = await listAgents(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data.length).toBe(1);
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

  describe("Email-shared agents", () => {
    it("should include shared agent with scope/name format", async () => {
      // Owner creates and shares an agent
      const owner = await context.setupUser({ prefix: "v1-owner" });
      const sharedAgentName = uniqueId("v1-shared");
      const { composeId } = await createTestCompose(sharedAgentName);
      await createTestPermission(composeId, "email", MOCK_USER_EMAIL);

      const ownerSuffix = owner.userId.replace("v1-owner-", "");
      const ownerScopeSlug = `scope-${ownerSuffix}`;

      // Switch to a different user (recipient)
      await context.setupUser({ prefix: "v1-recipient" });

      const request = createTestRequest(
        `http://localhost:3000/v1/agents?name=${sharedAgentName}`,
      );
      const response = await listAgents(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.length).toBe(1);
      expect(data.data[0].name).toBe(`${ownerScopeSlug}/${sharedAgentName}`);
    });

    it("should not show unshared agents from other users", async () => {
      // Owner creates an agent but does NOT share
      await context.setupUser({ prefix: "v1-private" });
      const privateAgentName = uniqueId("v1-private-agent");
      await createTestCompose(privateAgentName);

      // Switch to recipient
      await context.setupUser({ prefix: "v1-viewer" });

      const request = createTestRequest(
        `http://localhost:3000/v1/agents?name=${privateAgentName}`,
      );
      const response = await listAgents(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.length).toBe(0);
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
