import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { createHash } from "crypto";

/**
 * Helper to create a NextRequest for testing.
 */
function createTestRequest(url: string): NextRequest {
  return new NextRequest(url, {
    method: "GET",
  });
}

/**
 * Helper to generate a content hash for compose versions.
 */
function generateContentHash(content: object): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

// Mock Clerk auth (external SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

import {
  mockClerk,
  clearClerkMock,
} from "../../../../../src/__tests__/clerk-mock";

describe("GET /api/platform/logs", () => {
  const testUserId = "test-user-platform-logs";
  const testScopeId = randomUUID();
  const testScopeSlug = `test-logs-${testScopeId.slice(0, 8)}`;

  // Test data IDs
  const composeIds: string[] = [];
  const versionIds: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    initServices();

    // Clean up any existing test data
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

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

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock Clerk auth to return test user by default
    mockClerk({ userId: testUserId });
  });

  afterAll(async () => {
    clearClerkMock();

    // Cleanup in reverse order of creation
    for (const runId of runIds) {
      await globalThis.services.db
        .delete(agentRuns)
        .where(eq(agentRuns.id, runId));
    }

    for (const versionId of versionIds) {
      await globalThis.services.db
        .delete(agentComposeVersions)
        .where(eq(agentComposeVersions.id, versionId));
    }

    for (const composeId of composeIds) {
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, composeId));
    }

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toBe("Not authenticated");
  });

  it("should return empty list when user has no runs", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data).toEqual([]);
    expect(data.pagination.hasMore).toBe(false);
    expect(data.pagination.nextCursor).toBeNull();
  });

  it("should return list of run IDs ordered by createdAt DESC", async () => {
    // Create a compose and version first
    const composeId = randomUUID();
    const content = {
      version: "1.0",
      agents: {
        "test-agent": {
          description: "Test agent",
          provider: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };
    const versionId = generateContentHash(content);

    await globalThis.services.db.insert(agentComposes).values({
      id: composeId,
      name: "test-agent",
      userId: testUserId,
      scopeId: testScopeId,
      headVersionId: versionId,
    });
    composeIds.push(composeId);

    await globalThis.services.db.insert(agentComposeVersions).values({
      id: versionId,
      composeId: composeId,
      content: content,
      createdBy: testUserId,
    });
    versionIds.push(versionId);

    // Create multiple runs with different timestamps
    const now = new Date();
    const runData = [
      { id: randomUUID(), createdAt: new Date(now.getTime() - 3000) },
      { id: randomUUID(), createdAt: new Date(now.getTime() - 2000) },
      { id: randomUUID(), createdAt: new Date(now.getTime() - 1000) },
    ];

    for (const run of runData) {
      await globalThis.services.db.insert(agentRuns).values({
        id: run.id,
        userId: testUserId,
        agentComposeVersionId: versionId,
        prompt: "Test prompt",
        status: "completed",
        createdAt: run.createdAt,
      });
      runIds.push(run.id);
    }

    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data).toHaveLength(3);

    // Check ordering (newest first)
    expect(data.data[0].id).toBe(runData[2]!.id);
    expect(data.data[1].id).toBe(runData[1]!.id);
    expect(data.data[2].id).toBe(runData[0]!.id);
  });

  it("should paginate correctly with limit and cursor", async () => {
    // Request with limit=2
    const request1 = createTestRequest(
      "http://localhost:3000/api/platform/logs?limit=2",
    );
    const response1 = await GET(request1);
    const data1 = await response1.json();

    expect(response1.status).toBe(200);
    expect(data1.data).toHaveLength(2);
    expect(data1.pagination.hasMore).toBe(true);
    expect(data1.pagination.nextCursor).not.toBeNull();

    // Request second page using cursor
    const request2 = createTestRequest(
      `http://localhost:3000/api/platform/logs?limit=2&cursor=${encodeURIComponent(data1.pagination.nextCursor)}`,
    );
    const response2 = await GET(request2);
    const data2 = await response2.json();

    expect(response2.status).toBe(200);
    expect(data2.data).toHaveLength(1);
    expect(data2.pagination.hasMore).toBe(false);
    expect(data2.pagination.nextCursor).toBeNull();

    // Ensure no duplicate IDs between pages
    const allIds = [
      ...data1.data.map((r: { id: string }) => r.id),
      ...data2.data.map((r: { id: string }) => r.id),
    ];
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length);
  });

  it("should filter by agent name with fuzzy search", async () => {
    // Create another compose with different name
    const composeId2 = randomUUID();
    const content2 = {
      version: "1.0",
      agents: {
        "different-agent": {
          description: "Different agent",
          provider: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };
    const versionId2 = generateContentHash(content2);

    await globalThis.services.db.insert(agentComposes).values({
      id: composeId2,
      name: "different-agent",
      userId: testUserId,
      scopeId: testScopeId,
      headVersionId: versionId2,
    });
    composeIds.push(composeId2);

    await globalThis.services.db.insert(agentComposeVersions).values({
      id: versionId2,
      composeId: composeId2,
      content: content2,
      createdBy: testUserId,
    });
    versionIds.push(versionId2);

    // Create a run for the different agent
    const runId = randomUUID();
    await globalThis.services.db.insert(agentRuns).values({
      id: runId,
      userId: testUserId,
      agentComposeVersionId: versionId2,
      prompt: "Test prompt for different agent",
      status: "completed",
    });
    runIds.push(runId);

    // Search for "different"
    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs?search=different",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data).toHaveLength(1);
    expect(data.data[0].id).toBe(runId);
  });

  it("should return empty list when search has no matches", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs?search=nonexistent-agent-xyz",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data).toEqual([]);
    expect(data.pagination.hasMore).toBe(false);
  });

  it("should be case-insensitive for search", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs?search=DIFFERENT",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data.length).toBeGreaterThan(0);
  });

  it("should not return runs from other users", async () => {
    // Create run for another user
    const otherUserId = "other-user-platform-logs";
    const otherScopeId = randomUUID();

    await globalThis.services.db.insert(scopes).values({
      id: otherScopeId,
      slug: `test-other-${otherScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: otherUserId,
    });

    const otherComposeId = randomUUID();
    const otherContent = {
      version: "1.0",
      agents: {
        "other-user-agent": {
          description: "Other user agent",
          provider: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };
    const otherVersionId = generateContentHash(otherContent);

    await globalThis.services.db.insert(agentComposes).values({
      id: otherComposeId,
      name: "other-user-agent",
      userId: otherUserId,
      scopeId: otherScopeId,
      headVersionId: otherVersionId,
    });

    await globalThis.services.db.insert(agentComposeVersions).values({
      id: otherVersionId,
      composeId: otherComposeId,
      content: otherContent,
      createdBy: otherUserId,
    });

    const otherRunId = randomUUID();
    await globalThis.services.db.insert(agentRuns).values({
      id: otherRunId,
      userId: otherUserId,
      agentComposeVersionId: otherVersionId,
      prompt: "Other user prompt",
      status: "completed",
    });

    // List as test user - should not see other user's run
    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs",
    );
    const response = await GET(request);
    const data = await response.json();

    const otherRunInResults = data.data.some(
      (r: { id: string }) => r.id === otherRunId,
    );
    expect(otherRunInResults).toBe(false);

    // Cleanup other user's data
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, otherRunId));
    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, otherVersionId));
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, otherComposeId));
    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, otherScopeId));
  });

  it("should return 400 for invalid limit", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs?limit=0",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 for limit exceeding maximum", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs?limit=101",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });
});
