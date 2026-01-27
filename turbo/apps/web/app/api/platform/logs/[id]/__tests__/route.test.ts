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
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../../../src/db/schema/scope";
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
} from "../../../../../../src/__tests__/clerk-mock";

describe("GET /api/platform/logs/[id]", () => {
  const testUserId = "test-user-platform-log-detail";
  const testScopeId = randomUUID();
  const testScopeSlug = `test-log-detail-${testScopeId.slice(0, 8)}`;

  // Test data IDs
  let composeId: string;
  let versionId: string;
  let runId: string;

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

    // Create a compose and version
    composeId = randomUUID();
    const content = {
      version: "1.0",
      agents: {
        "test-detail-agent": {
          description: "Test agent for detail",
          provider: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };
    versionId = generateContentHash(content);

    await globalThis.services.db.insert(agentComposes).values({
      id: composeId,
      name: "test-detail-agent",
      userId: testUserId,
      scopeId: testScopeId,
      headVersionId: versionId,
    });

    await globalThis.services.db.insert(agentComposeVersions).values({
      id: versionId,
      composeId: composeId,
      content: content,
      createdBy: testUserId,
    });

    // Create a test run
    runId = randomUUID();
    const now = new Date();
    await globalThis.services.db.insert(agentRuns).values({
      id: runId,
      userId: testUserId,
      agentComposeVersionId: versionId,
      prompt: "Test prompt for detail",
      status: "completed",
      createdAt: now,
      startedAt: new Date(now.getTime() + 1000),
      completedAt: new Date(now.getTime() + 5000),
      result: {
        agentSessionId: "test-session-123",
        artifactName: "test-artifact",
        artifactVersion: "1.0.0",
      },
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
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, runId));

    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, versionId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, composeId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/platform/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toBe("Not authenticated");
  });

  it("should return 400 for invalid UUID format", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs/invalid-uuid",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return 404 for non-existent run", async () => {
    const nonExistentId = randomUUID();
    const request = createTestRequest(
      `http://localhost:3000/api/platform/logs/${nonExistentId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 404 when accessing another user's run", async () => {
    // Create another user's run
    const otherUserId = "other-user-log-detail";
    const otherScopeId = randomUUID();

    await globalThis.services.db.insert(scopes).values({
      id: otherScopeId,
      slug: `test-other-detail-${otherScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: otherUserId,
    });

    const otherComposeId = randomUUID();
    const otherContent = {
      version: "1.0",
      agents: {
        "other-detail-agent": {
          description: "Other user agent",
          provider: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };
    const otherVersionId = generateContentHash(otherContent);

    await globalThis.services.db.insert(agentComposes).values({
      id: otherComposeId,
      name: "other-detail-agent",
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

    // Try to access as test user
    const request = createTestRequest(
      `http://localhost:3000/api/platform/logs/${otherRunId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");

    // Cleanup
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

  it("should return full run details for authenticated owner", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/platform/logs/${runId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(runId);
    expect(data.sessionId).toBe("test-session-123");
    expect(data.agentName).toBe("test-detail-agent");
    expect(data.provider).toBe("claude-code");
    expect(data.status).toBe("completed");
    expect(data.prompt).toBe("Test prompt for detail");
    expect(data.error).toBeNull();
    expect(data.createdAt).toBeDefined();
    expect(data.startedAt).toBeDefined();
    expect(data.completedAt).toBeDefined();
    expect(data.artifact).toEqual({
      name: "test-artifact",
      version: "1.0.0",
    });
  });

  it("should handle run with single agent.provider format", async () => {
    // Create compose with single agent format
    const singleComposeId = randomUUID();
    const singleContent = {
      version: "1.0",
      agent: {
        description: "Single agent format",
        provider: "openai",
        working_dir: "/home/user/workspace",
      },
    };
    const singleVersionId = generateContentHash(singleContent);

    await globalThis.services.db.insert(agentComposes).values({
      id: singleComposeId,
      name: "single-agent",
      userId: testUserId,
      scopeId: testScopeId,
      headVersionId: singleVersionId,
    });

    await globalThis.services.db.insert(agentComposeVersions).values({
      id: singleVersionId,
      composeId: singleComposeId,
      content: singleContent,
      createdBy: testUserId,
    });

    const singleRunId = randomUUID();
    await globalThis.services.db.insert(agentRuns).values({
      id: singleRunId,
      userId: testUserId,
      agentComposeVersionId: singleVersionId,
      prompt: "Single agent prompt",
      status: "completed",
    });

    const request = createTestRequest(
      `http://localhost:3000/api/platform/logs/${singleRunId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.provider).toBe("openai");

    // Cleanup
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, singleRunId));
    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, singleVersionId));
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, singleComposeId));
  });

  it("should use default provider when not specified in compose", async () => {
    // Create compose without provider
    const noProviderComposeId = randomUUID();
    const noProviderContent = {
      version: "1.0",
      agents: {
        "no-provider-agent": {
          description: "Agent without provider",
          working_dir: "/home/user/workspace",
        },
      },
    };
    const noProviderVersionId = generateContentHash(noProviderContent);

    await globalThis.services.db.insert(agentComposes).values({
      id: noProviderComposeId,
      name: "no-provider-agent",
      userId: testUserId,
      scopeId: testScopeId,
      headVersionId: noProviderVersionId,
    });

    await globalThis.services.db.insert(agentComposeVersions).values({
      id: noProviderVersionId,
      composeId: noProviderComposeId,
      content: noProviderContent,
      createdBy: testUserId,
    });

    const noProviderRunId = randomUUID();
    await globalThis.services.db.insert(agentRuns).values({
      id: noProviderRunId,
      userId: testUserId,
      agentComposeVersionId: noProviderVersionId,
      prompt: "No provider prompt",
      status: "completed",
    });

    const request = createTestRequest(
      `http://localhost:3000/api/platform/logs/${noProviderRunId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.provider).toBeNull(); // no provider specified, returns null

    // Cleanup
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, noProviderRunId));
    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, noProviderVersionId));
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, noProviderComposeId));
  });

  it("should handle run without result data", async () => {
    // Create run without result
    const noResultRunId = randomUUID();
    await globalThis.services.db.insert(agentRuns).values({
      id: noResultRunId,
      userId: testUserId,
      agentComposeVersionId: versionId,
      prompt: "No result prompt",
      status: "pending",
      result: null,
    });

    const request = createTestRequest(
      `http://localhost:3000/api/platform/logs/${noResultRunId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.sessionId).toBeNull();
    expect(data.artifact).toEqual({
      name: null,
      version: null,
    });

    // Cleanup
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, noResultRunId));
  });

  it("should handle failed run with error message", async () => {
    // Create failed run
    const failedRunId = randomUUID();
    await globalThis.services.db.insert(agentRuns).values({
      id: failedRunId,
      userId: testUserId,
      agentComposeVersionId: versionId,
      prompt: "Failed run prompt",
      status: "failed",
      error: "Something went wrong",
    });

    const request = createTestRequest(
      `http://localhost:3000/api/platform/logs/${failedRunId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("failed");
    expect(data.error).toBe("Something went wrong");

    // Cleanup
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, failedRunId));
  });
});
