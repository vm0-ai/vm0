import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkLinkStatus, linkSlackAccount } from "../actions";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { initServices } from "../../../../src/lib/init-services";
import { slackInstallations } from "../../../../src/db/schema/slack-installation";
import { slackUserLinks } from "../../../../src/db/schema/slack-user-link";

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
      const user = await context.setupUser();
      initServices();

      const workspaceId = `T-test-${Date.now()}`;
      const slackUserId = `U-test-${Date.now()}`;

      // Create installation
      await globalThis.services.db.insert(slackInstallations).values({
        slackWorkspaceId: workspaceId,
        slackWorkspaceName: "Test Workspace",
        encryptedBotToken: "encrypted-token",
        botUserId: "B123456",
      });

      // Create user link
      await globalThis.services.db.insert(slackUserLinks).values({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const result = await checkLinkStatus(slackUserId, workspaceId);

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
      initServices();

      const workspaceId = `T-link-test-${Date.now()}`;
      const slackUserId = `U-link-test-${Date.now()}`;

      // Create installation
      await globalThis.services.db.insert(slackInstallations).values({
        slackWorkspaceId: workspaceId,
        slackWorkspaceName: "Link Test Workspace",
        encryptedBotToken: "encrypted-token",
        botUserId: "B123456",
      });

      const result = await linkSlackAccount(slackUserId, workspaceId);

      expect(result.success).toBe(true);
      expect(result.alreadyLinked).toBeUndefined();

      // Verify link was created
      const status = await checkLinkStatus(slackUserId, workspaceId);
      expect(status.isLinked).toBe(true);
    });

    it("should return alreadyLinked: true when re-linking same user", async () => {
      const user = await context.setupUser();
      initServices();

      const workspaceId = `T-relink-test-${Date.now()}`;
      const slackUserId = `U-relink-test-${Date.now()}`;

      // Create installation
      await globalThis.services.db.insert(slackInstallations).values({
        slackWorkspaceId: workspaceId,
        slackWorkspaceName: "Relink Test Workspace",
        encryptedBotToken: "encrypted-token",
        botUserId: "B123456",
      });

      // Create initial link
      await globalThis.services.db.insert(slackUserLinks).values({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      // Try to link again
      const result = await linkSlackAccount(slackUserId, workspaceId);

      expect(result.success).toBe(true);
      expect(result.alreadyLinked).toBe(true);
    });

    it("should return error when Slack account is linked to different VM0 user", async () => {
      // Create first user and link
      const user1 = await context.setupUser({ prefix: "user1" });
      initServices();

      const workspaceId = `T-conflict-test-${Date.now()}`;
      const slackUserId = `U-conflict-test-${Date.now()}`;

      // Create installation
      await globalThis.services.db.insert(slackInstallations).values({
        slackWorkspaceId: workspaceId,
        slackWorkspaceName: "Conflict Test Workspace",
        encryptedBotToken: "encrypted-token",
        botUserId: "B123456",
      });

      // Create link for user1
      await globalThis.services.db.insert(slackUserLinks).values({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user1.userId,
      });

      // Create second user and try to link same Slack account
      await context.setupUser({ prefix: "user2" });

      const result = await linkSlackAccount(slackUserId, workspaceId);

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        "already linked to a different VM0 account",
      );
    });
  });
});
