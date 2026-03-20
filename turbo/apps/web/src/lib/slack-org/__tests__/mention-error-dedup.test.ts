import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestSlackOrgInstallation,
  seedTestSlackOrgConnection,
  seedTestCompose,
  updateOrgDefaultAgent,
} from "../../../__tests__/api-test-helpers";
import { handleOrgMention } from "../handlers/mention";
import { handleOrgDirectMessage } from "../handlers/direct-message";

/**
 * Mock @slack/web-api (external dependency).
 * vi.hoisted() ensures the mock fns are available when vi.mock is hoisted.
 */
const {
  mockPostMessage,
  mockPostEphemeral,
  mockSetStatus,
  createMockWebClient,
} = vi.hoisted(() => {
  const mockPostMessage = vi.fn().mockResolvedValue({ ok: true, ts: "1.1" });
  const mockPostEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const mockSetStatus = vi.fn().mockResolvedValue({ ok: true });
  const mockUsersInfo = vi.fn().mockResolvedValue({
    ok: true,
    user: { id: "U-test", profile: { display_name: "Test" }, tz: "UTC" },
  });
  const mockConversationsReplies = vi.fn().mockResolvedValue({
    ok: true,
    messages: [],
  });
  const mockConversationsHistory = vi.fn().mockResolvedValue({
    ok: true,
    messages: [],
  });

  function createMockWebClient() {
    return {
      chat: {
        postMessage: mockPostMessage,
        postEphemeral: mockPostEphemeral,
      },
      assistant: {
        threads: { setStatus: mockSetStatus },
      },
      users: { info: mockUsersInfo },
      conversations: {
        replies: mockConversationsReplies,
        history: mockConversationsHistory,
      },
    };
  }

  return {
    mockPostMessage,
    mockPostEphemeral,
    mockSetStatus,
    createMockWebClient,
  };
});

vi.mock("@slack/web-api", () => ({
  WebClient: createMockWebClient,
}));

const context = testContext();

describe("Slack org error message deduplication", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    mockPostMessage.mockClear();
    mockPostEphemeral.mockClear();
    mockSetStatus.mockClear();
  });

  /**
   * Set up workspace installation + connection for the test user.
   */
  async function setupWorkspace(
    orgId: string,
    opts?: { slackUserId?: string },
  ): Promise<{ workspaceId: string; slackUserId: string }> {
    const workspaceId = uniqueId("T-ws");
    const slackUserId = opts?.slackUserId ?? uniqueId("U-slack");

    await createTestSlackOrgInstallation({ workspaceId, orgId });
    await seedTestSlackOrgConnection({
      slackUserId,
      slackWorkspaceId: workspaceId,
      vm0UserId: user.userId,
    });

    return { workspaceId, slackUserId };
  }

  describe("handleOrgMention", () => {
    it("should not post error when run was created (callback handles it)", async () => {
      // Set up a valid compose so the run IS created before dispatch fails
      const compose = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(user.orgId, compose.composeId);
      const { workspaceId, slackUserId } = await setupWorkspace(user.orgId);

      await handleOrgMention({
        workspaceId,
        channelId: "C-test",
        userId: slackUserId,
        messageText: "Hello agent",
        messageTs: "1000.001",
      });

      // The run was created but dispatch failed → runId exists.
      // Handler should NOT post an error (callback will handle it).
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it("should post error when run was not created (no callback)", async () => {
      // Set up a compose WITHOUT a version → startRun fails before creating the run
      const { composeId } = await seedTestCompose({
        userId: user.userId,
        name: uniqueId("agent"),
        orgId: user.orgId,
      });
      await updateOrgDefaultAgent(user.orgId, composeId);
      const { workspaceId, slackUserId } = await setupWorkspace(user.orgId);

      await handleOrgMention({
        workspaceId,
        channelId: "C-test",
        userId: slackUserId,
        messageText: "Hello agent",
        messageTs: "1000.002",
      });

      // startRun failed before creating a run → no runId → no callback.
      // Handler should post the error message.
      expect(mockPostMessage).toHaveBeenCalledOnce();
    });
  });

  describe("handleOrgDirectMessage", () => {
    it("should not post error when run was created (callback handles it)", async () => {
      const compose = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(user.orgId, compose.composeId);
      const { workspaceId, slackUserId } = await setupWorkspace(user.orgId);

      await handleOrgDirectMessage({
        workspaceId,
        channelId: "D-test",
        userId: slackUserId,
        messageText: "Hello agent",
        messageTs: "2000.001",
      });

      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it("should post error when run was not created (no callback)", async () => {
      const { composeId } = await seedTestCompose({
        userId: user.userId,
        name: uniqueId("agent"),
        orgId: user.orgId,
      });
      await updateOrgDefaultAgent(user.orgId, composeId);
      const { workspaceId, slackUserId } = await setupWorkspace(user.orgId);

      await handleOrgDirectMessage({
        workspaceId,
        channelId: "D-test",
        userId: slackUserId,
        messageText: "Hello agent",
        messageTs: "2000.002",
      });

      expect(mockPostMessage).toHaveBeenCalledOnce();
    });
  });
});
