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
import { GET as listAgents } from "../route";
import { GET as getAgent } from "../[id]/route";
import { GET as listVersions } from "../[id]/versions/route";
import { initServices } from "../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { computeComposeVersionId } from "../../../../src/lib/agent-compose/content-hash";
import type { AgentComposeYaml } from "../../../../src/types/agent-compose";

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

/**
 * Helper to create an agent directly in the database for testing.
 */
async function createTestAgent(
  userId: string,
  scopeId: string,
  name: string,
  config: AgentComposeYaml,
): Promise<{ id: string; versionId: string }> {
  const versionId = computeComposeVersionId(config);

  const [created] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId,
      scopeId,
      name,
    })
    .returning();

  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: created!.id,
    content: config,
    createdBy: userId,
  });

  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, created!.id));

  return { id: created!.id, versionId };
}

// Mock Clerk auth (external SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

import {
  mockClerk,
  clearClerkMock,
} from "../../../../src/__tests__/clerk-mock";

describe("Public API v1 - Agents Endpoints", () => {
  const testUserId = "test-user-public-api";
  const testScopeId = randomUUID();
  let testAgentId: string;

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

    // Create a test agent for use in subsequent tests
    const { id } = await createTestAgent(
      testUserId,
      testScopeId,
      "test-agent-v1",
      {
        version: "1.0",
        agents: {
          "test-agent-v1": {
            image: "vm0/claude-code:dev",
            framework: "claude-code",
          },
        },
      },
    );
    testAgentId = id;
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
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
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

    it("should filter by name when name parameter provided", async () => {
      const request = createTestRequest(
        "http://localhost:3000/v1/agents?name=test-agent-v1",
      );

      const response = await listAgents(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data.length).toBe(1);
      expect(data.data[0].name).toBe("test-agent-v1");
      expect(data.pagination.has_more).toBe(false);
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
      expect(data.pagination.has_more).toBe(false);
      expect(data.pagination.next_cursor).toBeNull();
    });

    it("should filter by name case-insensitively", async () => {
      const request = createTestRequest(
        "http://localhost:3000/v1/agents?name=TEST-AGENT-V1",
      );

      const response = await listAgents(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data.length).toBe(1);
      expect(data.data[0].name).toBe("test-agent-v1");
    });

    it("should filter by name combined with limit", async () => {
      const request = createTestRequest(
        "http://localhost:3000/v1/agents?name=test-agent-v1&limit=10",
      );

      const response = await listAgents(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data.length).toBe(1);
      expect(data.data[0].name).toBe("test-agent-v1");
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
      expect(data.name).toBe("test-agent-v1");
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
      const request = createTestRequest(
        `http://localhost:3000/v1/agents/${testAgentId}/versions`,
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
      expect(version.agent_id).toBe(testAgentId);
      expect(version.version_number).toBeDefined();
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
