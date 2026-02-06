import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import { checkLinkStatus, linkSlackAccount } from "../actions";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { slackUserLinks } from "../../../../src/db/schema/slack-user-link";
import { slackBindings } from "../../../../src/db/schema/slack-binding";
import {
  givenSlackWorkspaceInstalled,
  givenLinkedSlackUser,
  givenUserHasAgent,
} from "../../../../src/__tests__/slack/api-helpers";

// Mock external dependencies
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("Slack Link Actions", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("checkLinkStatus", () => {
    it("should return isLinked: false when user is not authenticated", async () => {
      mockClerk({ userId: null });

      const result = await checkLinkStatus("U123456", "T123456");

      expect(result.isLinked).toBe(false);
      expect(result.workspaceName).toBeUndefined();
    });

    it("should return isLinked: false when no link exists", async () => {
      await context.setupUser();

      const result = await checkLinkStatus("U-nonexistent", "T-nonexistent");

      expect(result.isLinked).toBe(false);
      expect(result.workspaceName).toBeUndefined();
    });

    it("should return isLinked: true with workspace name when link exists", async () => {
      const { userLink, installation } = await givenLinkedSlackUser({
        workspaceName: "Test Workspace",
      });

      const result = await checkLinkStatus(
        userLink.slackUserId,
        installation.slackWorkspaceId,
      );

      expect(result.isLinked).toBe(true);
      expect(result.workspaceName).toBe("Test Workspace");
    });
  });

  describe("linkSlackAccount", () => {
    it("should return error when user is not authenticated", async () => {
      mockClerk({ userId: null });

      const result = await linkSlackAccount("U123456", "T123456");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Not authenticated");
    });

    it("should return error when workspace installation does not exist", async () => {
      await context.setupUser();

      const result = await linkSlackAccount(
        "U-nonexistent",
        "T-workspace-not-installed",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Workspace not found");
    });

    it("should successfully link a new Slack account", async () => {
      await context.setupUser();
      const { installation } = await givenSlackWorkspaceInstalled();

      const slackUserId = `U-link-test-${Date.now()}`;

      const result = await linkSlackAccount(
        slackUserId,
        installation.slackWorkspaceId,
      );

      expect(result.success).toBe(true);
      expect(result.alreadyLinked).toBeUndefined();

      // Verify link was created via the server action
      const status = await checkLinkStatus(
        slackUserId,
        installation.slackWorkspaceId,
      );
      expect(status.isLinked).toBe(true);
    });

    it("should return alreadyLinked: true when re-linking same user", async () => {
      const { userLink, installation } = await givenLinkedSlackUser();

      const result = await linkSlackAccount(
        userLink.slackUserId,
        installation.slackWorkspaceId,
      );

      expect(result.success).toBe(true);
      expect(result.alreadyLinked).toBe(true);
    });

    it("should return error when Slack account is linked to different VM0 user", async () => {
      // Create first user and link
      const { userLink, installation } = await givenLinkedSlackUser();

      // Create second user and try to link same Slack account
      await context.setupUser({ prefix: "user2" });

      const result = await linkSlackAccount(
        userLink.slackUserId,
        installation.slackWorkspaceId,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        "already linked to a different VM0 account",
      );
    });

    it("should restore orphaned bindings when user re-links after logout", async () => {
      // Given a linked user with an agent (via API helpers)
      const { userLink, installation } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "test-agent",
        description: "A test agent",
      });

      // Mock Clerk to return the same vm0UserId
      mockClerk({ userId: userLink.vm0UserId });

      // Simulate logout - delete the user link (this orphans the binding)
      // Note: Direct DB operation is acceptable here because there's no API
      // endpoint for "unlink" — this simulates an internal state transition.
      await globalThis.services.db
        .delete(slackUserLinks)
        .where(
          and(
            eq(slackUserLinks.slackUserId, userLink.slackUserId),
            eq(slackUserLinks.slackWorkspaceId, userLink.slackWorkspaceId),
          ),
        );

      // Verify binding is now orphaned (DB assertion justified — orphan state
      // is not observable through any API)
      const [orphanedBinding] = await globalThis.services.db
        .select()
        .from(slackBindings)
        .where(
          and(
            eq(slackBindings.vm0UserId, userLink.vm0UserId),
            eq(slackBindings.slackWorkspaceId, installation.slackWorkspaceId),
            isNull(slackBindings.slackUserLinkId),
          ),
        );
      expect(orphanedBinding).toBeDefined();
      expect(orphanedBinding?.agentName).toBe("test-agent");

      // Re-link (simulate login again)
      const result = await linkSlackAccount(
        userLink.slackUserId,
        installation.slackWorkspaceId,
      );
      expect(result.success).toBe(true);

      // Verify binding is restored to the new user link
      const [restoredBinding] = await globalThis.services.db
        .select()
        .from(slackBindings)
        .where(
          and(
            eq(slackBindings.vm0UserId, userLink.vm0UserId),
            eq(slackBindings.agentName, binding.agentName),
          ),
        );

      expect(restoredBinding).toBeDefined();
      expect(restoredBinding?.slackUserLinkId).not.toBeNull();
      expect(restoredBinding?.agentName).toBe(binding.agentName);
    });
  });
});
