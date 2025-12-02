/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initServices } from "../../init-services";
import { agentSessions } from "../../../db/schema/agent-session";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { agentRuns } from "../../../db/schema/agent-run";
import { conversations } from "../../../db/schema/conversation";
import { AgentSessionService } from "../agent-session-service";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

describe("AgentSessionService", () => {
  let service: AgentSessionService;
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testComposeId = randomUUID();
  const testVersionId =
    randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const testRunId = randomUUID();
  const testConversationId = randomUUID();

  beforeEach(async () => {
    vi.clearAllMocks();
    initServices();
    service = new AgentSessionService();

    // Clean up any existing test data
    await globalThis.services.db
      .delete(agentSessions)
      .where(eq(agentSessions.userId, testUserId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, testVersionId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, testComposeId));

    // Create test agent config
    await globalThis.services.db.insert(agentComposes).values({
      id: testComposeId,
      userId: testUserId,
      name: "test-agent",
      headVersionId: testVersionId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create test agent version
    await globalThis.services.db.insert(agentComposeVersions).values({
      id: testVersionId,
      composeId: testComposeId,
      content: {
        version: "1.0",
        agents: {
          test: {
            working_dir: "/workspace",
            image: "test-image",
            provider: "claude-code",
          },
        },
      },
      createdBy: testUserId,
      createdAt: new Date(),
    });

    // Create test run
    await globalThis.services.db.insert(agentRuns).values({
      id: testRunId,
      userId: testUserId,
      agentComposeVersionId: testVersionId,
      status: "completed",
      prompt: "test prompt",
      createdAt: new Date(),
    });

    // Create test conversation
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
    // Clean up test data
    await globalThis.services.db
      .delete(agentSessions)
      .where(eq(agentSessions.userId, testUserId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, testVersionId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, testComposeId));
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
});
