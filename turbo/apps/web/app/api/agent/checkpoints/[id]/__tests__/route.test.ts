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
import { checkpoints } from "../../../../../../src/db/schema/checkpoint";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { agentComposeVersions } from "../../../../../../src/db/schema/agent-compose";
import { conversations } from "../../../../../../src/db/schema/conversation";
import { scopes } from "../../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { createHash } from "crypto";

/**
 * Helper to create a NextRequest for testing.
 */
function createTestRequest(
  url: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
  },
): NextRequest {
  return new NextRequest(url, {
    method: options?.method ?? "GET",
    headers: options?.headers ?? {},
  });
}

// Mock Clerk auth (external SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

import { auth } from "@clerk/nextjs/server";

const mockAuth = vi.mocked(auth);

describe("GET /api/agent/checkpoints/:id", () => {
  const testUserId = "test-user-checkpoints";
  const testScopeId = randomUUID();
  const testComposeId = randomUUID();
  const testRunId = randomUUID();
  const testConversationId = randomUUID();
  const testCheckpointId = randomUUID();

  // Create a deterministic version ID (SHA-256 hash)
  const testVersionContent = { version: "1.0", agents: {} };
  const testVersionId = createHash("sha256")
    .update(JSON.stringify(testVersionContent))
    .digest("hex");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  beforeAll(async () => {
    initServices();

    // Mock Clerk auth to return test user
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as unknown as Awaited<ReturnType<typeof auth>>);

    // Clean up any existing test data in correct order (respecting FK constraints)
    // 1. Delete checkpoints (depends on conversations, runs)
    await globalThis.services.db
      .delete(checkpoints)
      .where(eq(checkpoints.id, testCheckpointId));

    // 2. Delete conversations (depends on runs)
    await globalThis.services.db
      .delete(conversations)
      .where(eq(conversations.runId, testRunId));

    // 3. Delete runs (depends on compose versions) - includes test user and other users
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, "other-user-checkpoints"));

    // 4. Delete compose versions (depends on composes)
    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, testVersionId));

    // 5. Delete composes (depends on scopes)
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    // 6. Delete scopes
    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));

    // Create test scope
    await globalThis.services.db.insert(scopes).values({
      id: testScopeId,
      slug: `test-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
    });

    // Create test compose
    await globalThis.services.db.insert(agentComposes).values({
      id: testComposeId,
      name: "test-checkpoint-compose",
      userId: testUserId,
      scopeId: testScopeId,
      headVersionId: testVersionId,
    });

    // Create test compose version
    await globalThis.services.db.insert(agentComposeVersions).values({
      id: testVersionId,
      composeId: testComposeId,
      content: testVersionContent,
      createdBy: testUserId,
    });

    // Create test run
    await globalThis.services.db.insert(agentRuns).values({
      id: testRunId,
      userId: testUserId,
      agentComposeVersionId: testVersionId,
      status: "completed",
      prompt: "test prompt",
    });

    // Create test conversation
    await globalThis.services.db.insert(conversations).values({
      id: testConversationId,
      runId: testRunId,
      cliAgentType: "claude-code",
      cliAgentSessionId: "test-session-123",
      cliAgentSessionHistory: "[]",
    });

    // Create test checkpoint
    await globalThis.services.db.insert(checkpoints).values({
      id: testCheckpointId,
      runId: testRunId,
      conversationId: testConversationId,
      agentComposeSnapshot: {
        agentComposeVersionId: testVersionId,
        vars: { testVar: "testValue" },
        secretNames: ["SECRET_A", "SECRET_B"],
      },
      artifactSnapshot: {
        artifactName: "test-artifact",
        artifactVersion: "v1.0.0",
      },
      volumeVersionsSnapshot: {
        versions: { "volume-1": "v1.0.0" },
      },
    });
  });

  afterAll(async () => {
    // Cleanup in correct order (respecting FK constraints)
    // 1. Delete checkpoints
    await globalThis.services.db
      .delete(checkpoints)
      .where(eq(checkpoints.id, testCheckpointId));

    // 2. Delete conversations
    await globalThis.services.db
      .delete(conversations)
      .where(eq(conversations.runId, testRunId));

    // 3. Delete runs (includes test user and other users)
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, "other-user-checkpoints"));

    // 4. Delete compose versions
    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, testVersionId));

    // 5. Delete composes
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    // 6. Delete scopes
    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  it("should return checkpoint with agentComposeSnapshot including secretNames", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${testCheckpointId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(testCheckpointId);
    expect(data.runId).toBe(testRunId);
    expect(data.conversationId).toBe(testConversationId);
    expect(data.agentComposeSnapshot.agentComposeVersionId).toBe(testVersionId);
    expect(data.agentComposeSnapshot.vars).toEqual({ testVar: "testValue" });
    expect(data.agentComposeSnapshot.secretNames).toEqual([
      "SECRET_A",
      "SECRET_B",
    ]);
    expect(data.artifactSnapshot).toEqual({
      artifactName: "test-artifact",
      artifactVersion: "v1.0.0",
    });
    expect(data.volumeVersionsSnapshot).toEqual({
      versions: { "volume-1": "v1.0.0" },
    });
    expect(data.createdAt).toBeDefined();
  });

  it("should return 404 for non-existent checkpoint", async () => {
    const nonExistentId = randomUUID();
    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${nonExistentId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("Checkpoint not found");
  });

  it("should return 403 when accessing another user's checkpoint", async () => {
    const otherUserId = "other-user-checkpoints";
    const otherRunId = randomUUID();
    const otherCheckpointId = randomUUID();
    const otherConversationId = randomUUID();

    // Create run for another user
    await globalThis.services.db.insert(agentRuns).values({
      id: otherRunId,
      userId: otherUserId,
      agentComposeVersionId: testVersionId,
      status: "completed",
      prompt: "other prompt",
    });

    // Create conversation for other user's run
    await globalThis.services.db.insert(conversations).values({
      id: otherConversationId,
      runId: otherRunId,
      cliAgentType: "claude-code",
      cliAgentSessionId: "other-session-123",
      cliAgentSessionHistory: "[]",
    });

    // Create checkpoint for another user's run
    await globalThis.services.db.insert(checkpoints).values({
      id: otherCheckpointId,
      runId: otherRunId,
      conversationId: otherConversationId,
      agentComposeSnapshot: {
        agentComposeVersionId: testVersionId,
        secretNames: ["OTHER_SECRET"],
      },
      artifactSnapshot: {
        artifactName: "other-artifact",
        artifactVersion: "v1.0.0",
      },
    });

    // Try to access as test user
    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${otherCheckpointId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.code).toBe("FORBIDDEN");

    // Cleanup
    await globalThis.services.db
      .delete(checkpoints)
      .where(eq(checkpoints.id, otherCheckpointId));
    await globalThis.services.db
      .delete(conversations)
      .where(eq(conversations.id, otherConversationId));
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, otherRunId));
  });

  it("should return 401 when not authenticated", async () => {
    // Mock Clerk to return no user
    mockAuth.mockResolvedValueOnce({
      userId: null,
    } as unknown as Awaited<ReturnType<typeof auth>>);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${testCheckpointId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should handle checkpoint without optional fields in snapshot", async () => {
    const minimalCheckpointId = randomUUID();
    const minimalRunId = randomUUID();
    const minimalConversationId = randomUUID();

    await globalThis.services.db.insert(agentRuns).values({
      id: minimalRunId,
      userId: testUserId,
      agentComposeVersionId: testVersionId,
      status: "completed",
      prompt: "minimal prompt",
    });

    await globalThis.services.db.insert(conversations).values({
      id: minimalConversationId,
      runId: minimalRunId,
      cliAgentType: "claude-code",
      cliAgentSessionId: "minimal-session-123",
      cliAgentSessionHistory: "[]",
    });

    // Create checkpoint with minimal required fields
    // Note: artifactSnapshot is required by DB, volumeVersionsSnapshot is optional
    await globalThis.services.db.insert(checkpoints).values({
      id: minimalCheckpointId,
      runId: minimalRunId,
      conversationId: minimalConversationId,
      agentComposeSnapshot: {
        agentComposeVersionId: testVersionId,
        // No vars or secretNames - these are optional
      },
      artifactSnapshot: {
        artifactName: "minimal-artifact",
        artifactVersion: "v1.0.0",
      },
      // No volumeVersionsSnapshot - this is optional
    });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${minimalCheckpointId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    // secretNames should be undefined when not provided in snapshot
    expect(data.agentComposeSnapshot.secretNames).toBeUndefined();
    // artifactSnapshot is required so it should exist
    expect(data.artifactSnapshot).toEqual({
      artifactName: "minimal-artifact",
      artifactVersion: "v1.0.0",
    });
    // volumeVersionsSnapshot is optional and not provided
    expect(data.volumeVersionsSnapshot).toBeNull();

    // Cleanup
    await globalThis.services.db
      .delete(checkpoints)
      .where(eq(checkpoints.id, minimalCheckpointId));
    await globalThis.services.db
      .delete(conversations)
      .where(eq(conversations.id, minimalConversationId));
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, minimalRunId));
  });
});
