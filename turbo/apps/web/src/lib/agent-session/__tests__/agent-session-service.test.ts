import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initServices } from "../../init-services";
import { agentSessions } from "../../../db/schema/agent-session";
import { agentComposes } from "../../../db/schema/agent-compose";
import { agentRuns } from "../../../db/schema/agent-run";
import { conversations } from "../../../db/schema/conversation";
import { scopes } from "../../../db/schema/scope";
import { AgentSessionService } from "../agent-session-service";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createDefaultComposeConfig,
} from "../../../__tests__/api-test-helpers";

// Mock Clerk auth (needed for compose API)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

import { mockClerk, clearClerkMock } from "../../../__tests__/clerk-mock";
import { POST as createCompose } from "../../../../app/api/agent/composes/route";

describe("AgentSessionService", () => {
  let service: AgentSessionService;
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testAgentName = `test-agent-session-${Date.now()}`;
  const testScopeId = randomUUID();
  let testComposeId: string;
  let testVersionId: string;
  const testRunId = randomUUID();
  const testConversationId = randomUUID();

  beforeEach(async () => {
    vi.clearAllMocks();
    initServices();
    service = new AgentSessionService();

    // Mock Clerk auth for compose API (default for all tests)
    mockClerk({ userId: testUserId });

    // Clean up any existing test data
    await globalThis.services.db
      .delete(agentSessions)
      .where(eq(agentSessions.userId, testUserId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

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

    // Create test compose via API endpoint
    const config = createDefaultComposeConfig(testAgentName);
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await createCompose(request);
    const data = await response.json();
    testComposeId = data.composeId;
    testVersionId = data.versionId;

    // Create test run (still using DB since runs API would execute sandbox)
    await globalThis.services.db.insert(agentRuns).values({
      id: testRunId,
      userId: testUserId,
      agentComposeVersionId: testVersionId,
      status: "completed",
      prompt: "test prompt",
      createdAt: new Date(),
    });

    // Create test conversation (still using DB since no simple API for this)
    await globalThis.services.db.insert(conversations).values({
      id: testConversationId,
      runId: testRunId,
      cliAgentType: "claude-code",
      cliAgentSessionId: "cli-session-123",
      cliAgentSessionHistory: '{"type":"test"}',
      createdAt: new Date(),
    });
  });

  afterEach(async () => {
    clearClerkMock();
    // Clean up test data
    await globalThis.services.db
      .delete(agentSessions)
      .where(eq(agentSessions.userId, testUserId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  describe("create", () => {
    it("should create a new agent session", async () => {
      const session = await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        artifactName: "test-artifact",
        conversationId: testConversationId,
      });

      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(session.userId).toBe(testUserId);
      expect(session.agentComposeId).toBe(testComposeId);
      expect(session.artifactName).toBe("test-artifact");
      expect(session.conversationId).toBe(testConversationId);
    });

    it("should create session without conversationId", async () => {
      const session = await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        artifactName: "test-artifact",
      });

      expect(session).toBeDefined();
      expect(session.conversationId).toBeNull();
    });
  });

  describe("update", () => {
    it("should update session conversationId", async () => {
      // Create session first
      const session = await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        artifactName: "test-artifact",
      });

      expect(session.conversationId).toBeNull();

      // Update with conversationId
      const updated = await service.update(session.id, {
        conversationId: testConversationId,
      });

      expect(updated.conversationId).toBe(testConversationId);
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
        session.updatedAt.getTime(),
      );
    });

    it("should throw NotFoundError for non-existent session", async () => {
      const fakeId = randomUUID();
      await expect(
        service.update(fakeId, { conversationId: testConversationId }),
      ).rejects.toThrow("AgentSession not found");
    });
  });

  describe("getById", () => {
    it("should return session by id", async () => {
      const created = await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        artifactName: "test-artifact",
      });

      const found = await service.getById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    it("should return null for non-existent session", async () => {
      const fakeId = randomUUID();
      const found = await service.getById(fakeId);
      expect(found).toBeNull();
    });
  });

  describe("getByIdWithConversation", () => {
    it("should return session with conversation data", async () => {
      const created = await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        artifactName: "test-artifact",
        conversationId: testConversationId,
      });

      const found = await service.getByIdWithConversation(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.conversation).toBeDefined();
      expect(found?.conversation?.cliAgentType).toBe("claude-code");
      expect(found?.conversation?.cliAgentSessionId).toBe("cli-session-123");
    });

    it("should return session with null conversation when not set", async () => {
      const created = await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        artifactName: "test-artifact",
      });

      const found = await service.getByIdWithConversation(created.id);

      expect(found).toBeDefined();
      expect(found?.conversation).toBeNull();
    });
  });

  describe("getByUserId", () => {
    it("should return all sessions for a user", async () => {
      // Create multiple sessions
      await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        artifactName: "artifact-1",
      });

      await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        artifactName: "artifact-2",
      });

      const sessions = await service.getByUserId(testUserId);

      expect(sessions).toHaveLength(2);
    });

    it("should return empty array for user with no sessions", async () => {
      const sessions = await service.getByUserId("non-existent-user");
      expect(sessions).toHaveLength(0);
    });
  });

  describe("findOrCreate", () => {
    it("should create new session when none exists", async () => {
      const result = await service.findOrCreate(
        testUserId,
        testComposeId,
        "new-artifact",
        testConversationId,
      );

      expect(result.created).toBe(true);
      expect(result.session.artifactName).toBe("new-artifact");
      expect(result.session.conversationId).toBe(testConversationId);
    });

    it("should return existing session and update conversationId", async () => {
      // Create initial session
      const initial = await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        artifactName: "existing-artifact",
      });

      expect(initial.conversationId).toBeNull();

      // Find or create should return existing and update conversationId
      const result = await service.findOrCreate(
        testUserId,
        testComposeId,
        "existing-artifact",
        testConversationId,
      );

      expect(result.created).toBe(false);
      expect(result.session.id).toBe(initial.id);
      expect(result.session.conversationId).toBe(testConversationId);
    });

    it("should return existing session without updating when no conversationId provided", async () => {
      // Create initial session with conversationId
      const initial = await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        artifactName: "existing-artifact",
        conversationId: testConversationId,
      });

      // Find or create without conversationId should keep existing
      const result = await service.findOrCreate(
        testUserId,
        testComposeId,
        "existing-artifact",
      );

      expect(result.created).toBe(false);
      expect(result.session.id).toBe(initial.id);
      expect(result.session.conversationId).toBe(testConversationId);
    });

    it("should handle undefined artifactName correctly (sessions without artifact)", async () => {
      // First call should create a new session with null artifactName
      const result1 = await service.findOrCreate(
        testUserId,
        testComposeId,
        undefined, // No artifact
        testConversationId,
      );

      expect(result1.created).toBe(true);
      expect(result1.session.artifactName).toBeNull();

      // Second call should find the existing session with null artifactName
      const result2 = await service.findOrCreate(
        testUserId,
        testComposeId,
        undefined, // No artifact
      );

      expect(result2.created).toBe(false);
      expect(result2.session.id).toBe(result1.session.id);
      expect(result2.session.artifactName).toBeNull();
    });

    it("should distinguish between sessions with artifact and without artifact", async () => {
      // Create session without artifact
      const noArtifactResult = await service.findOrCreate(
        testUserId,
        testComposeId,
        undefined, // No artifact
      );

      expect(noArtifactResult.created).toBe(true);
      expect(noArtifactResult.session.artifactName).toBeNull();

      // Create session with artifact - should create new session
      const withArtifactResult = await service.findOrCreate(
        testUserId,
        testComposeId,
        "my-artifact",
      );

      expect(withArtifactResult.created).toBe(true);
      expect(withArtifactResult.session.artifactName).toBe("my-artifact");
      expect(withArtifactResult.session.id).not.toBe(
        noArtifactResult.session.id,
      );

      // Query for no-artifact session should still find the original
      const noArtifactAgain = await service.findOrCreate(
        testUserId,
        testComposeId,
        undefined,
      );

      expect(noArtifactAgain.created).toBe(false);
      expect(noArtifactAgain.session.id).toBe(noArtifactResult.session.id);
    });
  });

  describe("delete", () => {
    it("should delete existing session", async () => {
      const created = await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        artifactName: "to-delete",
      });

      const deleted = await service.delete(created.id);
      expect(deleted).toBe(true);

      const found = await service.getById(created.id);
      expect(found).toBeNull();
    });

    it("should return false for non-existent session", async () => {
      const fakeId = randomUUID();
      const deleted = await service.delete(fakeId);
      expect(deleted).toBe(false);
    });
  });

  describe("agentComposeVersionId and volumeVersions", () => {
    it("should create session with agentComposeVersionId", async () => {
      const session = await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        agentComposeVersionId: testVersionId,
        artifactName: "test-artifact-with-version",
      });

      expect(session).toBeDefined();
      expect(session.agentComposeVersionId).toBe(testVersionId);
    });

    it("should create session with volumeVersions", async () => {
      const volumeVersions = {
        "test-volume": "v1.0.0",
        "another-volume": "v2.0.0",
      };

      const session = await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        artifactName: "test-artifact-with-volumes",
        volumeVersions,
      });

      expect(session).toBeDefined();
      expect(session.volumeVersions).toEqual(volumeVersions);
    });

    it("should store agentComposeVersionId on findOrCreate for new session", async () => {
      const result = await service.findOrCreate(
        testUserId,
        testComposeId,
        "new-artifact-with-version",
        testConversationId,
        undefined, // vars
        undefined, // secrets
        testVersionId, // agentComposeVersionId
        { "test-vol": "v1" }, // volumeVersions
      );

      expect(result.created).toBe(true);
      expect(result.session.agentComposeVersionId).toBe(testVersionId);
      expect(result.session.volumeVersions).toEqual({ "test-vol": "v1" });
    });

    it("should NOT update agentComposeVersionId on findOrCreate for existing session", async () => {
      // Create initial session with version ID
      const initial = await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        agentComposeVersionId: testVersionId,
        artifactName: "existing-artifact-with-version",
        volumeVersions: { "old-vol": "v1" },
      });

      expect(initial.agentComposeVersionId).toBe(testVersionId);

      // Find or create should NOT update version ID (it's fixed at creation)
      const result = await service.findOrCreate(
        testUserId,
        testComposeId,
        "existing-artifact-with-version",
        testConversationId,
        undefined,
        undefined,
        "different-version-id", // Try to update version
        { "new-vol": "v2" }, // Try to update volume versions
      );

      expect(result.created).toBe(false);
      expect(result.session.id).toBe(initial.id);
      // Version ID should remain unchanged
      expect(result.session.agentComposeVersionId).toBe(testVersionId);
      // Volume versions should remain unchanged
      expect(result.session.volumeVersions).toEqual({ "old-vol": "v1" });
    });

    it("should return agentComposeVersionId in getByIdWithConversation", async () => {
      const created = await service.create({
        userId: testUserId,
        agentComposeId: testComposeId,
        agentComposeVersionId: testVersionId,
        artifactName: "test-artifact-get-with-conv",
        conversationId: testConversationId,
        volumeVersions: { "test-vol": "v1.0" },
      });

      const found = await service.getByIdWithConversation(created.id);

      expect(found).toBeDefined();
      expect(found?.agentComposeVersionId).toBe(testVersionId);
      expect(found?.volumeVersions).toEqual({ "test-vol": "v1.0" });
    });
  });
});
