import { describe, it, expect, beforeEach } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../__tests__/test-helpers";
import {
  createTestSlackOrgInstallation,
  seedTestSlackOrgConnection,
  countSlackOrgInstallations,
  countSlackOrgConnections,
} from "../../../../__tests__/api-test-helpers";
import {
  adminConnect,
  memberConnect,
  disconnect,
  cleanupWorkspaceInstallation,
  notifyConnectSuccess,
} from "../connect-service";

const context = testContext();

describe("connect-service", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  describe("adminConnect", () => {
    it("binds unbound workspace to org and creates connection", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: null });

      const result = await adminConnect({
        userId: user.userId,
        orgId: user.orgId,
        workspaceId,
        slackUserId: uniqueId("U-slack"),
      });

      expect(result.installation.orgId).toBe(user.orgId);
      expect(result.connection.vm0UserId).toBe(user.userId);
      expect(await countSlackOrgConnections(workspaceId)).toBe(1);
    });

    it("is idempotent when workspace is already bound to the same org", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const result = await adminConnect({
        userId: user.userId,
        orgId: user.orgId,
        workspaceId,
        slackUserId,
      });

      expect(result.installation.orgId).toBe(user.orgId);
      expect(result.connection).toBeDefined();
    });

    it("throws when workspace is bound to a different org", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: uniqueId("org-other"),
      });

      await expect(
        adminConnect({
          userId: user.userId,
          orgId: user.orgId,
          workspaceId,
          slackUserId: uniqueId("U-slack"),
        }),
      ).rejects.toThrow("already connected to a different org");
    });

    it("handles idempotent reconnect (connection already exists)", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: null });

      // First connect
      await adminConnect({
        userId: user.userId,
        orgId: user.orgId,
        workspaceId,
        slackUserId,
      });

      // Second connect — should not throw
      const result = await adminConnect({
        userId: user.userId,
        orgId: user.orgId,
        workspaceId,
        slackUserId,
      });

      expect(result.connection.slackUserId).toBe(slackUserId);
      // Still only one connection
      expect(await countSlackOrgConnections(workspaceId)).toBe(1);
    });
  });

  describe("memberConnect", () => {
    it("creates connection for bound workspace", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const result = await memberConnect({
        userId: user.userId,
        orgId: user.orgId,
        workspaceId,
        slackUserId: uniqueId("U-slack"),
      });

      expect(result.connection.vm0UserId).toBe(user.userId);
      expect(await countSlackOrgConnections(workspaceId)).toBe(1);
    });

    it("throws when workspace is not installed", async () => {
      await expect(
        memberConnect({
          userId: user.userId,
          orgId: user.orgId,
          workspaceId: "T-nonexistent",
          slackUserId: uniqueId("U-slack"),
        }),
      ).rejects.toThrow("installation not found");
    });

    it("throws when workspace is unbound (no admin connect yet)", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: null });

      await expect(
        memberConnect({
          userId: user.userId,
          orgId: user.orgId,
          workspaceId,
          slackUserId: uniqueId("U-slack"),
        }),
      ).rejects.toThrow("admin must connect first");
    });

    it("throws when workspace is bound to a different org", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: uniqueId("org-other"),
      });

      await expect(
        memberConnect({
          userId: user.userId,
          orgId: user.orgId,
          workspaceId,
          slackUserId: uniqueId("U-slack"),
        }),
      ).rejects.toThrow("different org");
    });
  });

  describe("disconnect", () => {
    it("deletes the connection record", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      const { connectionId } = await seedTestSlackOrgConnection({
        slackUserId: uniqueId("U-slack"),
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      await disconnect({ connectionId, userId: user.userId });

      expect(await countSlackOrgConnections(workspaceId)).toBe(0);
    });
  });

  describe("cleanupWorkspaceInstallation", () => {
    it("deletes installation and connections", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: uniqueId("org"),
      });

      await seedTestSlackOrgConnection({
        slackUserId: uniqueId("U-slack"),
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const deleted = await cleanupWorkspaceInstallation(workspaceId);

      expect(deleted).toBe(true);
      expect(await countSlackOrgInstallations(workspaceId)).toBe(0);
      expect(await countSlackOrgConnections(workspaceId)).toBe(0);
    });

    it("returns false when workspace does not exist", async () => {
      const deleted = await cleanupWorkspaceInstallation("T-nonexistent");
      expect(deleted).toBe(false);
    });

    it("handles workspace with no connections", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: null });

      const deleted = await cleanupWorkspaceInstallation(workspaceId);

      expect(deleted).toBe(true);
      expect(await countSlackOrgInstallations(workspaceId)).toBe(0);
    });
  });

  describe("notifyConnectSuccess", () => {
    it("sends ephemeral message when channelId is provided", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      const channelId = uniqueId("C-ch");

      const { installation } = await createTestSlackOrgInstallation({
        workspaceId,
        orgId: user.orgId,
      });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      await notifyConnectSuccess({
        installation,
        slackUserId,
        orgId: user.orgId,
        channelId,
      });

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledOnce();
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: channelId,
          user: slackUserId,
        }),
      );
    });

    it("sends DM with welcome thread when no channelId", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");

      const { installation } = await createTestSlackOrgInstallation({
        workspaceId,
        orgId: user.orgId,
      });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      await notifyConnectSuccess({
        installation,
        slackUserId,
        orgId: user.orgId,
      });

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      // Should send connect success DM and welcome thread reply
      expect(
        (
          mockClient.chat.postMessage as ReturnType<
            typeof import("vitest").vi.fn
          >
        ).mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
    });
  });
});
