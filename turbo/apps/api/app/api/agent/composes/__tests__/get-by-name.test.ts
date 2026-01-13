import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { initServices } from "../../../../../src/lib/init-services";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

/**
 * Helper to create a NextRequest for testing.
 * Uses actual NextRequest constructor so ts-rest handler gets nextUrl property.
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
let mockUserId = "test-user-get-by-name";
vi.mock("../../../../../src/lib/auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

describe("GET /api/agent/composes?name=<name>", () => {
  const testUserId = "test-user-get-by-name";
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

    // Create test scope for the user (required for compose creation)
    await globalThis.services.db.insert(scopes).values({
      id: testScopeId,
      slug: `test-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
    });
  });

  afterAll(async () => {
    // Cleanup: Delete test composes
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  it("should return compose when name exists", async () => {
    // Create a test compose
    const config = {
      version: "1.0",
      agents: {
        "test-get-by-name-success": {
          description: "Test description",
          image: "vm0/claude-code:dev",
          provider: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };

    const createRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const createResponse = await POST(createRequest);
    const createData = await createResponse.json();
    expect(createResponse.status).toBe(201);

    // Now get it by name
    const getRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes?name=test-get-by-name-success",
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.id).toBe(createData.composeId);
    expect(getData.name).toBe("test-get-by-name-success");
    expect(getData.content.agents["test-get-by-name-success"]).toBeDefined();
    expect(getData.content.agents["test-get-by-name-success"].description).toBe(
      "Test description",
    );
    expect(getData.createdAt).toBeDefined();
    expect(getData.updatedAt).toBeDefined();

    // Cleanup
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, createData.composeId));
  });

  it("should return 400 when name does not exist", async () => {
    const getRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes?name=nonexistent-agent",
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(400);
    expect(getData.error.message).toContain("Agent compose not found");
    expect(getData.error.message).toContain("nonexistent-agent");
  });

  it("should return 400 when name query parameter is missing", async () => {
    const getRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(400);
    // Zod validation returns "expected string, received undefined" for missing required params
    expect(getData.error.message).toContain("expected string");
  });

  it("should only return compose for authenticated user", async () => {
    // Create scopes for isolated users
    const user1Id = "user-1-isolation";
    const user2Id = "user-2-isolation";
    const scope1Id = randomUUID();
    const scope2Id = randomUUID();

    // Create scope for user 1
    await globalThis.services.db.insert(scopes).values({
      id: scope1Id,
      slug: `test-${scope1Id.slice(0, 8)}`,
      type: "personal",
      ownerId: user1Id,
    });

    // Create scope for user 2
    await globalThis.services.db.insert(scopes).values({
      id: scope2Id,
      slug: `test-${scope2Id.slice(0, 8)}`,
      type: "personal",
      ownerId: user2Id,
    });

    // Create compose as user 1
    mockUserId = user1Id;
    const config = {
      version: "1.0",
      agents: {
        "test-user-isolation": {
          description: "Test",
          image: "vm0/claude-code:dev",
          provider: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };

    const createRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const createResponse = await POST(createRequest);
    expect(createResponse.status).toBe(201);

    // Try to get it as user 2
    mockUserId = user2Id;
    const getRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes?name=test-user-isolation",
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(400);
    expect(getData.error.message).toContain("Agent compose not found");

    // Cleanup
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, user1Id));
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, user2Id));
    await globalThis.services.db.delete(scopes).where(eq(scopes.id, scope1Id));
    await globalThis.services.db.delete(scopes).where(eq(scopes.id, scope2Id));

    // Reset mockUserId
    mockUserId = "test-user-get-by-name";
  });

  it("should handle URL-encoded names correctly", async () => {
    // Create a test compose with hyphens
    const config = {
      version: "1.0",
      agents: {
        "test-agent-with-hyphens": {
          description: "Test description",
          image: "vm0/claude-code:dev",
          provider: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };

    const createRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const createResponse = await POST(createRequest);
    const createData = await createResponse.json();
    expect(createResponse.status).toBe(201);

    // Get it with URL-encoded name
    const encodedName = encodeURIComponent("test-agent-with-hyphens");
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${encodedName}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.name).toBe("test-agent-with-hyphens");

    // Cleanup
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, createData.composeId));
  });
});
