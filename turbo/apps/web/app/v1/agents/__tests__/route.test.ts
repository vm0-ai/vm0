import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as listAgents, POST as createAgent } from "../route";
import {
  GET as getAgent,
  PUT as updateAgent,
  DELETE as deleteAgent,
} from "../[id]/route";
import { GET as listVersions } from "../[id]/versions/route";
import { initServices } from "../../../../src/lib/init-services";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../src/db/schema/scope";
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
let mockUserId = "test-user-public-api";
vi.mock("../../../../src/lib/auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

describe("Public API v1 - Agents Endpoints", () => {
  const testUserId = "test-user-public-api";
  const testScopeId = randomUUID();

  beforeAll(async () => {
    initServices();

    // Clean up any existing test data
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

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
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  describe("POST /v1/agents - Create Agent", () => {
    it("should create a new agent", async () => {
      const request = createTestRequest("http://localhost:3000/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test-agent-v1",
          config: {
            version: "1.0",
            agents: {
              "test-agent-v1": {
                image: "vm0/claude-code:dev",
                provider: "claude-code",
              },
            },
          },
        }),
      });

      const response = await createAgent(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.id).toBeDefined();
      expect(data.name).toBe("test-agent-v1");
      expect(data.current_version_id).toBeDefined();
      expect(data.created_at).toBeDefined();
      expect(data.updated_at).toBeDefined();
    });

    it("should return 409 when agent already exists", async () => {
      const request = createTestRequest("http://localhost:3000/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test-agent-v1",
          config: {
            version: "1.0",
            agents: {
              "test-agent-v1": {
                image: "vm0/claude-code:dev",
                provider: "claude-code",
              },
            },
          },
        }),
      });

      const response = await createAgent(request);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error.type).toBe("conflict_error");
      expect(data.error.code).toBe("resource_already_exists");
    });

    it("should return 401 for unauthenticated request", async () => {
      mockUserId = "";

      const request = createTestRequest("http://localhost:3000/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test-agent-unauth",
          config: { version: "1.0", agents: {} },
        }),
      });

      const response = await createAgent(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.type).toBe("authentication_error");

      mockUserId = testUserId;
    });
  });

  describe("GET /v1/agents - List Agents", () => {
    it("should list agents with pagination", async () => {
      const request = createTestRequest("http://localhost:3000/v1/agents");

      const response = await listAgents(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.pagination).toBeDefined();
      expect(data.pagination.has_more).toBe(false);
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
  });

  describe("GET /v1/agents/:id - Get Agent", () => {
    let agentId: string;

    beforeAll(async () => {
      // Get agent ID from earlier creation
      const agents = await globalThis.services.db
        .select()
        .from(agentComposes)
        .where(eq(agentComposes.name, "test-agent-v1"))
        .limit(1);

      agentId = agents[0]!.id;
    });

    it("should get agent by ID", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/agents/${agentId}`,
      );

      const response = await getAgent(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(agentId);
      expect(data.name).toBe("test-agent-v1");
      expect(data.config).toBeDefined();
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

  describe("PUT /v1/agents/:id - Update Agent", () => {
    let agentId: string;

    beforeAll(async () => {
      const agents = await globalThis.services.db
        .select()
        .from(agentComposes)
        .where(eq(agentComposes.name, "test-agent-v1"))
        .limit(1);

      agentId = agents[0]!.id;
    });

    it("should update agent config and create new version", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/agents/${agentId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            config: {
              version: "1.1",
              agents: {
                "test-agent-v1": {
                  image: "vm0/claude-code:dev",
                  provider: "claude-code",
                  description: "Updated description",
                },
              },
            },
          }),
        },
      );

      const response = await updateAgent(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(agentId);
      expect(data.config.version).toBe("1.1");
    });

    it("should return 404 for non-existent agent", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/agents/${fakeId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            config: { version: "1.0", agents: {} },
          }),
        },
      );

      const response = await updateAgent(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.type).toBe("not_found_error");
    });
  });

  describe("GET /v1/agents/:id/versions - List Agent Versions", () => {
    let agentId: string;

    beforeAll(async () => {
      const agents = await globalThis.services.db
        .select()
        .from(agentComposes)
        .where(eq(agentComposes.name, "test-agent-v1"))
        .limit(1);

      agentId = agents[0]!.id;
    });

    it("should list agent versions", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/agents/${agentId}/versions`,
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
      expect(version.agent_id).toBe(agentId);
      expect(version.version_number).toBeDefined();
      expect(version.config).toBeDefined();
      expect(version.created_at).toBeDefined();
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

  describe("DELETE /v1/agents/:id - Delete Agent", () => {
    let agentIdToDelete: string;

    beforeAll(async () => {
      // Create a new agent to delete
      const request = createTestRequest("http://localhost:3000/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test-agent-delete",
          config: {
            version: "1.0",
            agents: {
              "test-agent-delete": {
                image: "vm0/claude-code:dev",
                provider: "claude-code",
              },
            },
          },
        }),
      });

      const response = await createAgent(request);
      const data = await response.json();
      agentIdToDelete = data.id;
    });

    it("should delete agent", async () => {
      const request = createTestRequest(
        `http://localhost:3000/v1/agents/${agentIdToDelete}`,
        { method: "DELETE" },
      );

      const response = await deleteAgent(request);

      expect(response.status).toBe(204);

      // Verify agent is deleted
      const getRequest = createTestRequest(
        `http://localhost:3000/v1/agents/${agentIdToDelete}`,
      );

      const getResponse = await getAgent(getRequest);

      expect(getResponse.status).toBe(404);
    });

    it("should return 404 for non-existent agent", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/v1/agents/${fakeId}`,
        { method: "DELETE" },
      );

      const response = await deleteAgent(request);
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
