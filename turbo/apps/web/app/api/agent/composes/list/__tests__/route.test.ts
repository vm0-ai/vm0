import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { POST } from "../../route";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../../../src/db/schema/scope";
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

// Mock Next.js headers() function
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// Mock Clerk auth (external SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);

describe("GET /api/agent/composes/list", () => {
  const testUserId = "test-user-list";
  const testScopeId = randomUUID();
  const testScopeSlug = `test-list-${testScopeId.slice(0, 8)}`;

  beforeAll(async () => {
    initServices();

    // Mock headers() - return empty headers so auth falls through to Clerk
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Mock Clerk auth to return test user
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as unknown as Awaited<ReturnType<typeof auth>>);

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
      slug: testScopeSlug,
      type: "personal",
      ownerId: testUserId,
    });
  });

  afterAll(async () => {
    // Cleanup: Delete test composes and scope
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  it("should return 401 when not authenticated", async () => {
    // Mock Clerk to return no user
    mockAuth.mockResolvedValueOnce({
      userId: null,
    } as unknown as Awaited<ReturnType<typeof auth>>);

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/list",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toBe("Not authenticated");
  });

  it("should return empty array when no composes exist", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/list",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.composes).toEqual([]);
  });

  it("should return all composes for the user scope", async () => {
    // Create two test composes
    const config1 = {
      version: "1.0",
      agents: {
        "test-list-agent-1": {
          description: "First agent",
          framework: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };

    const config2 = {
      version: "1.0",
      agents: {
        "test-list-agent-2": {
          description: "Second agent",
          framework: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };

    // Create first compose
    const createRequest1 = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config1 }),
      },
    );
    const createResponse1 = await POST(createRequest1);
    expect(createResponse1.status).toBe(201);

    // Create second compose
    const createRequest2 = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config2 }),
      },
    );
    const createResponse2 = await POST(createRequest2);
    expect(createResponse2.status).toBe(201);

    // List composes
    const listRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes/list",
    );
    const listResponse = await GET(listRequest);
    const listData = await listResponse.json();

    expect(listResponse.status).toBe(200);
    expect(listData.composes).toHaveLength(2);

    // Check that both agents are in the list
    const names = listData.composes.map((c: { name: string }) => c.name);
    expect(names).toContain("test-list-agent-1");
    expect(names).toContain("test-list-agent-2");

    // Check structure of each compose
    for (const compose of listData.composes) {
      expect(compose.name).toBeDefined();
      expect(compose.headVersionId).toBeDefined();
      expect(compose.updatedAt).toBeDefined();
      // headVersionId should be 64 hex chars
      expect(compose.headVersionId).toMatch(/^[a-f0-9]{64}$/);
    }

    // Cleanup
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));
  });

  it("should filter by scope correctly", async () => {
    // Create another user and scope
    const otherUserId = "test-user-list-other";
    const otherScopeId = randomUUID();
    const otherScopeSlug = `test-other-${otherScopeId.slice(0, 8)}`;

    await globalThis.services.db.insert(scopes).values({
      id: otherScopeId,
      slug: otherScopeSlug,
      type: "personal",
      ownerId: otherUserId,
    });

    // Create compose as other user
    mockAuth.mockResolvedValueOnce({
      userId: otherUserId,
    } as unknown as Awaited<ReturnType<typeof auth>>);

    const config = {
      version: "1.0",
      agents: {
        "test-other-agent": {
          description: "Other user's agent",
          framework: "claude-code",
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
    await POST(createRequest);

    // Switch back to original user and list their composes (uses default mock)
    const listRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes/list",
    );
    const listResponse = await GET(listRequest);
    const listData = await listResponse.json();

    expect(listResponse.status).toBe(200);
    // Should not include other user's compose
    const names = listData.composes.map((c: { name: string }) => c.name);
    expect(names).not.toContain("test-other-agent");

    // Cleanup
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, otherUserId));
    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, otherScopeId));
  });

  it("should return 400 for non-existent scope", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/list?scope=nonexistent-scope",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("Scope not found");
  });

  it("should return 403 when user tries to access another user's scope", async () => {
    // Create another user's scope
    const otherUserId = "test-user-unauthorized";
    const otherScopeId = randomUUID();
    const otherScopeSlug = `test-unauth-${otherScopeId.slice(0, 8)}`;

    await globalThis.services.db.insert(scopes).values({
      id: otherScopeId,
      slug: otherScopeSlug,
      type: "personal",
      ownerId: otherUserId,
    });

    // Try to access other user's scope as test user
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/list?scope=${otherScopeSlug}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.code).toBe("FORBIDDEN");
    expect(data.error.message).toContain("don't have access");

    // Cleanup
    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, otherScopeId));
  });

  it("should list composes by specified scope slug", async () => {
    // Create a compose first
    const config = {
      version: "1.0",
      agents: {
        "test-scope-agent": {
          description: "Agent with scope",
          framework: "claude-code",
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
    await POST(createRequest);

    // List by scope slug
    const listRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes/list?scope=${testScopeSlug}`,
    );
    const listResponse = await GET(listRequest);
    const listData = await listResponse.json();

    expect(listResponse.status).toBe(200);
    const names = listData.composes.map((c: { name: string }) => c.name);
    expect(names).toContain("test-scope-agent");

    // Cleanup
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));
  });
});
