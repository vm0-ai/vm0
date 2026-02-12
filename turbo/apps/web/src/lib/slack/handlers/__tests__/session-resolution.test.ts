import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { resolveSessionCompose, getWorkspaceAgent } from "../shared";
import { agentSessions } from "../../../../db/schema/agent-session";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../db/schema/agent-compose";
import { agentRuns } from "../../../../db/schema/agent-run";
import { conversations } from "../../../../db/schema/conversation";
import { scopes } from "../../../../db/schema/scope";
import { eq } from "drizzle-orm";
import { initServices } from "../../../init-services";

const context = testContext();

describe("resolveSessionCompose", () => {
  beforeEach(() => {
    context.setupMocks();
    initServices();
  });

  async function createTestScope(userId: string) {
    const [scope] = await globalThis.services.db
      .insert(scopes)
      .values({
        slug: uniqueId("scope"),
        type: "personal",
        ownerId: userId,
      })
      .returning();
    return scope!;
  }

  async function createTestCompose(
    userId: string,
    scopeId: string,
    name: string,
  ) {
    const [compose] = await globalThis.services.db
      .insert(agentComposes)
      .values({
        userId,
        scopeId,
        name,
      })
      .returning();
    return compose!;
  }

  async function createTestComposeVersion(composeId: string, userId: string) {
    const versionId = uniqueId("version");
    await globalThis.services.db.insert(agentComposeVersions).values({
      id: versionId,
      composeId,
      content: { name: "test-agent", model: "claude-3-5-sonnet-20241022" },
      createdBy: userId,
    });
    // Update compose to point to this version
    await globalThis.services.db
      .update(agentComposes)
      .set({ headVersionId: versionId })
      .where(eq(agentComposes.id, composeId));
    return versionId;
  }

  async function createTestRun(userId: string, versionId: string) {
    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId,
        agentComposeVersionId: versionId,
        status: "completed",
        prompt: "test prompt",
      })
      .returning({ id: agentRuns.id });
    return run!;
  }

  async function createTestConversation(runId: string) {
    const [conversation] = await globalThis.services.db
      .insert(conversations)
      .values({
        runId,
        cliAgentType: "claude",
        cliAgentSessionId: uniqueId("cli-session"),
        cliAgentSessionHistory: "[]",
      })
      .returning({ id: conversations.id });
    return conversation!;
  }

  async function createTestSession(userId: string, agentComposeId: string) {
    const [session] = await globalThis.services.db
      .insert(agentSessions)
      .values({ userId, agentComposeId })
      .returning({ id: agentSessions.id });
    return session!;
  }

  async function createTestSessionWithConversation(
    userId: string,
    agentComposeId: string,
  ) {
    // Create compose version
    const versionId = await createTestComposeVersion(agentComposeId, userId);
    // Create run
    const run = await createTestRun(userId, versionId);
    // Create conversation
    const conversation = await createTestConversation(run.id);
    // Create session with conversation
    const [session] = await globalThis.services.db
      .insert(agentSessions)
      .values({
        userId,
        agentComposeId,
        conversationId: conversation.id,
      })
      .returning({ id: agentSessions.id });
    return session!;
  }

  describe("when session exists and belongs to user", () => {
    it("should return compose info from session", async () => {
      const userId = uniqueId("test-user");

      // Create scope and compose
      const scope = await createTestScope(userId);
      const compose = await createTestCompose(
        userId,
        scope.id,
        "session-agent",
      );

      // Create an agent session with conversation (required by validateAgentSession)
      const session = await createTestSessionWithConversation(
        userId,
        compose.id,
      );

      // Resolve session compose
      const result = await resolveSessionCompose(session.id, userId);

      expect(result).toBeDefined();
      expect(result!.composeId).toBe(compose.id);
      expect(result!.agentName).toBe("session-agent");
    });
  });

  describe("when session does not exist", () => {
    it("should return undefined", async () => {
      const userId = uniqueId("test-user");

      const result = await resolveSessionCompose(
        "non-existent-session-id",
        userId,
      );

      expect(result).toBeUndefined();
    });
  });

  describe("when session belongs to different user", () => {
    it("should return undefined", async () => {
      const ownerUserId = uniqueId("owner-user");
      const otherUserId = uniqueId("other-user");

      // Create scope and compose for owner
      const scope = await createTestScope(ownerUserId);
      const compose = await createTestCompose(
        ownerUserId,
        scope.id,
        "owner-agent",
      );

      // Create a session owned by the owner
      const session = await createTestSession(ownerUserId, compose.id);

      // Try to resolve with other user - should fail authorization
      const result = await resolveSessionCompose(session.id, otherUserId);

      expect(result).toBeUndefined();
    });
  });

  describe("when session compose is deleted", () => {
    it("should return undefined if compose no longer exists", async () => {
      const userId = uniqueId("test-user");

      // Create scope and compose
      const scope = await createTestScope(userId);
      const compose = await createTestCompose(
        userId,
        scope.id,
        "deleted-agent",
      );

      // Create a session
      const session = await createTestSession(userId, compose.id);

      // Delete the compose (simulate orphaned session)
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, compose.id));

      // Resolve should return undefined since compose doesn't exist
      const result = await resolveSessionCompose(session.id, userId);

      expect(result).toBeUndefined();
    });
  });
});

describe("getWorkspaceAgent", () => {
  beforeEach(() => {
    context.setupMocks();
    initServices();
  });

  it("should return agent info for valid composeId", async () => {
    const userId = uniqueId("test-user");

    // Create scope and compose directly
    const [scope] = await globalThis.services.db
      .insert(scopes)
      .values({
        slug: uniqueId("scope"),
        type: "personal",
        ownerId: userId,
      })
      .returning();

    const [compose] = await globalThis.services.db
      .insert(agentComposes)
      .values({
        userId,
        scopeId: scope!.id,
        name: "test-agent",
      })
      .returning();

    const result = await getWorkspaceAgent(compose!.id);

    expect(result).toBeDefined();
    expect(result!.id).toBe(compose!.id);
    expect(result!.name).toBe("test-agent");
  });

  it("should return undefined for non-existent composeId", async () => {
    // Use valid UUID format that doesn't exist in database
    const result = await getWorkspaceAgent(
      "00000000-0000-0000-0000-000000000000",
    );

    expect(result).toBeUndefined();
  });
});
