import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  createTestAgentSession,
  createTestSessionWithConversation,
} from "../../../../__tests__/api-test-helpers";
import { resolveSessionCompose, getWorkspaceAgent } from "../shared";

const context = testContext();

describe("resolveSessionCompose", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("when session exists and belongs to user", () => {
    it("should return compose info from session", async () => {
      const userId = uniqueId("test-user");

      // Create compose using testContext helper
      const compose = await context.createAgentCompose(userId, {
        name: "session-agent",
      });

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

      // Create compose for owner
      const compose = await context.createAgentCompose(ownerUserId, {
        name: "owner-agent",
      });

      // Create a session owned by the owner (without conversation - auth check happens first)
      const session = await createTestAgentSession(ownerUserId, compose.id);

      // Try to resolve with other user - should fail authorization
      const result = await resolveSessionCompose(session.id, otherUserId);

      expect(result).toBeUndefined();
    });
  });

  describe("when session has no conversation", () => {
    it("should return undefined", async () => {
      const userId = uniqueId("test-user");

      // Create compose
      const compose = await context.createAgentCompose(userId, {
        name: "test-agent",
      });

      // Create a session without conversation
      const session = await createTestAgentSession(userId, compose.id);

      // Resolve should return undefined since session has no conversation
      const result = await resolveSessionCompose(session.id, userId);

      expect(result).toBeUndefined();
    });
  });
});

describe("getWorkspaceAgent", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return agent info for valid composeId", async () => {
    const userId = uniqueId("test-user");

    // Create compose using testContext helper
    const compose = await context.createAgentCompose(userId, {
      name: "test-agent",
    });

    const result = await getWorkspaceAgent(compose.id);

    expect(result).toBeDefined();
    expect(result!.id).toBe(compose.id);
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
