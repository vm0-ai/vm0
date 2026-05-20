import { createHmac } from "crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import {
  completeTestRun,
  createTestCompose,
  findTestRunCallbacks,
  findTestRunsByUserAndPromptContaining,
  findTestZeroRun,
  insertOrgModelPolicy,
  insertUserModelPreference,
  insertVm0ApiKeys,
  setOrgCredits,
  setTestRunModelProvider,
  setTestRunSelectedModel,
  updateOrgDefaultAgent,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  createTestSlackOrgInstallation,
  insertTestSlackOrgThreadSession,
  seedTestSlackOrgConnection,
} from "../../../../../../src/__tests__/db-test-seeders/slack";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import {
  countSlackOrgInstallations,
  countSlackOrgConnections,
  seedSlackUserAgentPreference,
} from "../../../../../../src/__tests__/db-test-assertions/slack";
import {
  seedOrphanCompose,
  clearComposeHeadVersion,
} from "../../../../../../src/__tests__/db-test-seeders/agents";
import { reloadEnv } from "../../../../../../src/env";
import { nextAfterArgForms } from "../../../../../../src/__tests__/next-after-hooks";

vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core/feature-switch");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const { POST } = await import("../route");

const SIGNING_SECRET = "test-slack-signing-secret";

const context = testContext();

/** Create a Slack event request with valid HMAC signature */
function createSlackEventRequest(payload: Record<string, unknown>): Request {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const baseString = `v0:${timestamp}:${body}`;
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(baseString).digest("hex")}`;

  return new Request("http://localhost:3000/api/zero/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

describe("POST /api/zero/slack/events", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    reloadEnv();
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  describe("url_verification", () => {
    it("returns challenge for url_verification event", async () => {
      const request = createSlackEventRequest({
        type: "url_verification",
        challenge: "test-challenge-123",
        token: "test-token",
      });
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.challenge).toBe("test-challenge-123");
    });
  });

  describe("signature verification", () => {
    it("returns 401 when signature headers are missing", async () => {
      const request = new Request(
        "http://localhost:3000/api/zero/slack/events",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "event_callback" }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it("returns 401 when signature is invalid", async () => {
      const request = new Request(
        "http://localhost:3000/api/zero/slack/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-slack-request-timestamp": Math.floor(
              Date.now() / 1000,
            ).toString(),
            "x-slack-signature": "v0=invalid_signature",
          },
          body: JSON.stringify({ type: "event_callback" }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(401);
    });
  });

  describe("app_mention — pre-dispatch validation", () => {
    it("silently returns when workspace has no installation", async () => {
      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: "T-nonexistent-ws",
        event: {
          type: "app_mention",
          user: "U-random",
          text: "Hello",
          ts: uniqueId("ts"),
          channel: "C-test",
          event_ts: uniqueId("ts"),
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
      expect(mockClient.chat.postEphemeral).not.toHaveBeenCalled();
    });

    it("silently returns when installation has no orgId bound", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: null });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_mention",
          user: "U-random",
          text: "Hello",
          ts: uniqueId("ts"),
          channel: "C-test",
          event_ts: uniqueId("ts"),
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
      expect(mockClient.chat.postEphemeral).not.toHaveBeenCalled();
    });

    it("sends ephemeral login prompt when user is not connected", async () => {
      const workspaceId = uniqueId("T-ws");
      const channelId = uniqueId("C-ch");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_mention",
          user: "U-not-connected",
          text: "Hello agent",
          ts: uniqueId("ts"),
          channel: channelId,
          event_ts: uniqueId("ts"),
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledOnce();
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: channelId,
          user: "U-not-connected",
        }),
      );
    });

    it("sends ephemeral message when no default agent is configured", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_mention",
          user: slackUserId,
          text: "Hello agent",
          ts: uniqueId("ts"),
          channel: "C-test",
          event_ts: uniqueId("ts"),
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledOnce();
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("No agent is configured"),
        }),
      );
    });

    it("sends ephemeral message when configured agent is not found", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });
      // Create a compose record WITHOUT a zero_agents row so getWorkspaceAgent returns undefined
      const { composeId: orphanId } = await seedOrphanCompose({
        userId: user.userId,
        name: uniqueId("orphan-agent"),
        orgId: user.orgId,
      });
      await updateOrgDefaultAgent(user.orgId, orphanId);

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_mention",
          user: slackUserId,
          text: "Hello agent",
          ts: uniqueId("ts"),
          channel: "C-test",
          event_ts: uniqueId("ts"),
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledOnce();
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("could not be found"),
        }),
      );
    });
  });

  describe("app_mention — error deduplication", () => {
    async function setupWorkspace(orgId: string) {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");

      await createTestSlackOrgInstallation({ workspaceId, orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      return { workspaceId, slackUserId };
    }

    it("does not post error when run was created (callback handles it)", async () => {
      const compose = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(user.orgId, compose.agentId);
      const { workspaceId, slackUserId } = await setupWorkspace(user.orgId);

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_mention",
          user: slackUserId,
          text: "Hello agent",
          ts: "1000.001",
          channel: "C-test",
          event_ts: "1000.001",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Drain after() callbacks to run the handler
      await context.mocks.flushAfter();

      // The run was created but dispatch failed → callback handles error.
      // Verify via Slack mock: postMessage should NOT have been called for error
      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it("posts error when run was not created (no callback)", async () => {
      // Set up a compose WITHOUT a version → createZeroRun fails before creating the run
      const { composeId, agentId } = await createTestCompose(uniqueId("agent"));
      await clearComposeHeadVersion(composeId);
      await updateOrgDefaultAgent(user.orgId, agentId);
      const { workspaceId, slackUserId } = await setupWorkspace(user.orgId);

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_mention",
          user: slackUserId,
          text: "Hello agent",
          ts: "1000.002",
          channel: "C-test",
          event_ts: "1000.002",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      // createZeroRun failed before creating a run → no callback → handler posts error
      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();
    });
  });

  describe("direct_message — routing filters", () => {
    it("ignores messages with bot_id (bot messages)", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: "U-someone",
          text: "I am a bot",
          ts: uniqueId("ts"),
          channel: "D-test",
          event_ts: uniqueId("ts"),
          bot_id: "B-bot",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
      expect(mockClient.chat.postEphemeral).not.toHaveBeenCalled();
    });

    it("ignores messages with non-file_share subtypes", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: "U-someone",
          text: "edited message",
          ts: uniqueId("ts"),
          channel: "D-test",
          event_ts: uniqueId("ts"),
          subtype: "message_changed",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it("processes file_share subtype messages", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: "U-not-connected",
          text: "file upload",
          ts: uniqueId("ts"),
          channel: "D-test",
          event_ts: uniqueId("ts"),
          subtype: "file_share",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // DM handler was invoked — user not connected so login prompt is sent via postMessage
      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();
    });

    it("ignores non-im channel type messages", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "channel",
          user: "U-someone",
          text: "Hello",
          ts: uniqueId("ts"),
          channel: "C-test",
          event_ts: uniqueId("ts"),
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });
  });

  describe("direct_message — pre-dispatch validation", () => {
    it("silently returns when workspace has no installation", async () => {
      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: "T-nonexistent-dm",
        event: {
          type: "message",
          channel_type: "im",
          user: "U-random",
          text: "Hello",
          ts: uniqueId("ts"),
          channel: "D-test",
          event_ts: uniqueId("ts"),
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it("sends login prompt via postMessage when user is not connected", async () => {
      const workspaceId = uniqueId("T-ws");
      const channelId = uniqueId("D-ch");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: "U-not-connected",
          text: "Hello agent",
          ts: uniqueId("ts"),
          channel: channelId,
          event_ts: uniqueId("ts"),
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // DM handler uses postMessage (not postEphemeral) for login prompt
      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: channelId,
        }),
      );
      expect(mockClient.chat.postEphemeral).not.toHaveBeenCalled();
    });

    it("sends message when no default agent is configured", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: slackUserId,
          text: "Hello agent",
          ts: uniqueId("ts"),
          channel: "D-test",
          event_ts: uniqueId("ts"),
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("No agent is configured"),
        }),
      );
    });

    it("sends message when configured agent is not found", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });
      const { composeId: orphanId } = await seedOrphanCompose({
        userId: user.userId,
        name: uniqueId("orphan-agent"),
        orgId: user.orgId,
      });
      await updateOrgDefaultAgent(user.orgId, orphanId);

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: slackUserId,
          text: "Hello agent",
          ts: uniqueId("ts"),
          channel: "D-test",
          event_ts: uniqueId("ts"),
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("could not be found"),
        }),
      );
    });
  });

  describe("direct_message — error deduplication", () => {
    async function setupWorkspace(orgId: string) {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");

      await createTestSlackOrgInstallation({ workspaceId, orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      return { workspaceId, slackUserId };
    }

    it("does not post error when run was created (callback handles it)", async () => {
      const compose = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(user.orgId, compose.agentId);
      const { workspaceId, slackUserId } = await setupWorkspace(user.orgId);

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: slackUserId,
          text: "Hello agent",
          ts: "2000.001",
          channel: "D-test",
          event_ts: "2000.001",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it("posts error when run was not created (no callback)", async () => {
      const { composeId, agentId } = await createTestCompose(uniqueId("agent"));
      await clearComposeHeadVersion(composeId);
      await updateOrgDefaultAgent(user.orgId, agentId);
      const { workspaceId, slackUserId } = await setupWorkspace(user.orgId);

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: slackUserId,
          text: "Hello agent",
          ts: "2000.002",
          channel: "D-test",
          event_ts: "2000.002",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();
    });
  });

  describe("direct_message — session model compatibility", () => {
    it("starts a new thread session when the selected model changed", async () => {
      mockIsFeatureEnabled.mockReturnValue(true);
      await setOrgCredits(user.orgId, 100_000);

      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      const channelId = uniqueId("D-model");
      const threadTs = "2400.001";
      const { composeId, agentId } = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(user.orgId, agentId);
      await insertOrgModelPolicy({
        orgId: user.orgId,
        model: "claude-sonnet-4-6",
        isDefault: true,
      });
      await insertOrgModelPolicy({
        orgId: user.orgId,
        model: "claude-opus-4-7",
      });
      await insertUserModelPreference({
        orgId: user.orgId,
        userId: user.userId,
        model: "claude-opus-4-7",
      });
      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: user.orgId,
      });
      const { connectionId } = await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const previous = await seedTestRun(user.userId, composeId, {
        prompt: "previous slack model session",
        triggerSource: "slack",
      });
      const { agentSessionId } = await completeTestRun(
        user.userId,
        previous.runId,
      );
      await setTestRunModelProvider(previous.runId, "vm0");
      await setTestRunSelectedModel(previous.runId, "claude-sonnet-4-6");
      await insertTestSlackOrgThreadSession({
        connectionId,
        agentSessionId,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
      });

      const prompt = `model changed ${uniqueId("slack")}`;
      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: slackUserId,
          text: prompt,
          ts: "2400.002",
          thread_ts: threadTs,
          channel: channelId,
          event_ts: "2400.002",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const runs = await findTestRunsByUserAndPromptContaining(
        user.userId,
        prompt,
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]?.continuedFromSessionId).toBeNull();
      expect(runs[0]?.sessionId).not.toBe(agentSessionId);
      await expect(findTestZeroRun(runs[0]!.id)).resolves.toEqual(
        expect.objectContaining({
          triggerSource: "slack",
          selectedModel: "claude-opus-4-7",
        }),
      );

      const callbacks = await findTestRunCallbacks(runs[0]!.id);
      expect(callbacks[0]?.payload).toEqual(
        expect.objectContaining({
          connectionId,
          threadTs,
        }),
      );
      expect(callbacks[0]?.payload).not.toHaveProperty("existingSessionId");
    });

    it("starts a new thread session when the selected model provider changed", async () => {
      mockIsFeatureEnabled.mockReturnValue(true);
      await setOrgCredits(user.orgId, 100_000);

      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      const channelId = uniqueId("D-provider");
      const threadTs = "2401.001";
      const { composeId, agentId } = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(user.orgId, agentId);
      await insertVm0ApiKeys([
        {
          vendor: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "vm0-key-claude-sonnet-4-6",
        },
      ]);
      await insertOrgModelPolicy({
        orgId: user.orgId,
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "vm0",
      });
      await insertUserModelPreference({
        orgId: user.orgId,
        userId: user.userId,
        model: "claude-sonnet-4-6",
      });
      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: user.orgId,
      });
      const { connectionId } = await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const previous = await seedTestRun(user.userId, composeId, {
        prompt: "previous slack provider session",
        triggerSource: "slack",
      });
      const { agentSessionId } = await completeTestRun(
        user.userId,
        previous.runId,
      );
      await setTestRunModelProvider(previous.runId, "openrouter-api-key");
      await setTestRunSelectedModel(previous.runId, "claude-sonnet-4-6");
      await insertTestSlackOrgThreadSession({
        connectionId,
        agentSessionId,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
      });

      const prompt = `provider changed ${uniqueId("slack")}`;
      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: slackUserId,
          text: prompt,
          ts: "2401.002",
          thread_ts: threadTs,
          channel: channelId,
          event_ts: "2401.002",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const runs = await findTestRunsByUserAndPromptContaining(
        user.userId,
        prompt,
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]?.continuedFromSessionId).toBeNull();
      expect(runs[0]?.sessionId).not.toBe(agentSessionId);
      await expect(findTestZeroRun(runs[0]!.id)).resolves.toEqual(
        expect.objectContaining({
          modelProvider: "vm0",
          selectedModel: "claude-sonnet-4-6",
          triggerSource: "slack",
        }),
      );
    });

    it("starts a new thread session when the default model provider changed", async () => {
      mockIsFeatureEnabled.mockReturnValue(true);
      await setOrgCredits(user.orgId, 100_000);

      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      const channelId = uniqueId("D-default-provider");
      const threadTs = "2402.001";
      const { composeId, agentId } = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(user.orgId, agentId);
      await insertVm0ApiKeys([
        {
          vendor: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "vm0-key-default-claude-sonnet-4-6",
        },
      ]);
      await insertOrgModelPolicy({
        orgId: user.orgId,
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "vm0",
      });
      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: user.orgId,
      });
      const { connectionId } = await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const previous = await seedTestRun(user.userId, composeId, {
        prompt: "previous slack default provider session",
        triggerSource: "slack",
      });
      const { agentSessionId } = await completeTestRun(
        user.userId,
        previous.runId,
      );
      await setTestRunModelProvider(previous.runId, "openrouter-api-key");
      await setTestRunSelectedModel(previous.runId, "claude-sonnet-4-6");
      await insertTestSlackOrgThreadSession({
        connectionId,
        agentSessionId,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
      });

      const prompt = `default provider changed ${uniqueId("slack")}`;
      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: slackUserId,
          text: prompt,
          ts: "2402.002",
          thread_ts: threadTs,
          channel: channelId,
          event_ts: "2402.002",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const runs = await findTestRunsByUserAndPromptContaining(
        user.userId,
        prompt,
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]?.continuedFromSessionId).toBeNull();
      expect(runs[0]?.sessionId).not.toBe(agentSessionId);
      await expect(findTestZeroRun(runs[0]!.id)).resolves.toEqual(
        expect.objectContaining({
          modelProvider: "vm0",
          selectedModel: "claude-sonnet-4-6",
          triggerSource: "slack",
        }),
      );
    });
  });

  describe("x-slack-retry-num header", () => {
    /** Create a Slack event request with X-Slack-Retry-Num header set */
    function createSlackRetryRequest(
      payload: Record<string, unknown>,
      retryNum = "1",
    ): Request {
      const body = JSON.stringify(payload);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const baseString = `v0:${timestamp}:${body}`;
      const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(baseString).digest("hex")}`;

      return new Request("http://localhost:3000/api/zero/slack/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
          "x-slack-retry-num": retryNum,
        },
        body,
      });
    }

    it("ignores DM retry requests without processing", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");

      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: user.orgId,
      });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });
      const { agentId } = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(user.orgId, agentId);

      const request = createSlackRetryRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: slackUserId,
          text: "Hello agent",
          ts: "3000.001",
          channel: "D-retry",
          event_ts: "3000.001",
        },
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.assistant.threads.setStatus).not.toHaveBeenCalled();
    });

    it("ignores mention retry requests without processing", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");

      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: user.orgId,
      });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });
      const { agentId } = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(user.orgId, agentId);

      const request = createSlackRetryRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_mention",
          user: slackUserId,
          text: "<@U-bot> Hello",
          ts: "3000.002",
          channel: "C-retry",
          event_ts: "3000.002",
        },
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.assistant.threads.setStatus).not.toHaveBeenCalled();
    });
  });

  describe("app_home_opened — home tab", () => {
    it("silently returns when workspace has no installation", async () => {
      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: "T-nonexistent-home",
        event: {
          type: "app_home_opened",
          user: "U-random",
          tab: "home",
          channel: "D-test",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.views.publish).not.toHaveBeenCalled();
    });

    it("publishes connect prompt when user is not connected", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_home_opened",
          user: "U-not-connected",
          tab: "home",
          channel: "D-test",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.views.publish).toHaveBeenCalledOnce();
      expect(mockClient.views.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: "U-not-connected",
        }),
      );
    });

    it("publishes linked App Home when user is connected", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_home_opened",
          user: slackUserId,
          tab: "home",
          channel: "D-test",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.views.publish).toHaveBeenCalledOnce();
      expect(mockClient.views.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: slackUserId,
        }),
      );
    });
  });

  describe("app_home_opened — messages tab", () => {
    it("silently returns when workspace has no installation", async () => {
      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: "T-nonexistent-msg",
        event: {
          type: "app_home_opened",
          user: "U-random",
          tab: "messages",
          channel: "D-test",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it("silently returns when user is not connected", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_home_opened",
          user: "U-not-connected",
          tab: "messages",
          channel: "D-test",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it("sends welcome message on first messages tab open", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      const channelId = uniqueId("D-ch");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_home_opened",
          user: slackUserId,
          tab: "messages",
          channel: channelId,
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: channelId,
        }),
      );
    });

    it("does not send welcome message on subsequent messages tab opens", async () => {
      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      const channelId = uniqueId("D-ch");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      // First open — sends welcome
      const request1 = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_home_opened",
          user: slackUserId,
          tab: "messages",
          channel: channelId,
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });
      await POST(request1);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();

      // Second open — should NOT send welcome again
      const request2 = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_home_opened",
          user: slackUserId,
          tab: "messages",
          channel: channelId,
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });
      await POST(request2);
      await context.mocks.flushAfter();

      // Still only one call from the first open
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();
    });
  });

  describe("app_uninstalled — cleanup", () => {
    it("deletes installation and all connections for a workspace", async () => {
      const workspaceId = uniqueId("T-ws");

      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: uniqueId("org"),
      });
      await seedTestSlackOrgConnection({
        slackUserId: "U001",
        slackWorkspaceId: workspaceId,
        vm0UserId: uniqueId("user"),
      });
      await seedTestSlackOrgConnection({
        slackUserId: "U002",
        slackWorkspaceId: workspaceId,
        vm0UserId: uniqueId("user"),
      });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: { type: "app_uninstalled" },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      expect(await countSlackOrgInstallations(workspaceId)).toBe(0);
      expect(await countSlackOrgConnections(workspaceId)).toBe(0);
    });

    it("handles nonexistent workspace gracefully", async () => {
      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: "T-nonexistent",
        event: { type: "app_uninstalled" },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Should not throw
      await context.mocks.flushAfter();
    });

    it("handles workspace with no connections", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: null });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: { type: "app_uninstalled" },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      expect(await countSlackOrgInstallations(workspaceId)).toBe(0);
    });
  });

  describe("tokens_revoked — cleanup", () => {
    it("cleans up workspace when bot tokens are revoked", async () => {
      const workspaceId = uniqueId("T-ws");

      await createTestSlackOrgInstallation({
        workspaceId,
        orgId: uniqueId("org"),
      });
      await seedTestSlackOrgConnection({
        slackUserId: "U001",
        slackWorkspaceId: workspaceId,
        vm0UserId: uniqueId("user"),
      });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "tokens_revoked",
          tokens: { bot: ["xoxb-revoked"] },
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      expect(await countSlackOrgInstallations(workspaceId)).toBe(0);
      expect(await countSlackOrgConnections(workspaceId)).toBe(0);
    });
  });

  // Regression: createZeroRun schedules its Phase 2 dispatch via a nested
  // after() inside handleOrgMention/handleOrgDirectMessage. If the route
  // registers the outer after() with an already-started promise, the nested
  // after() is scheduled after the Next.js request context has been finalized
  // and Phase 2 dispatch never runs — runs remain Pending forever.
  describe("after() callback form (nested-after propagation)", () => {
    it("registers app_mention handler via callback form", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_mention",
          user: "U-random",
          text: "Hello",
          ts: uniqueId("ts"),
          channel: "C-test",
          event_ts: uniqueId("ts"),
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      await POST(request);

      expect(nextAfterArgForms).toEqual(["fn"]);
    });

    it("registers direct_message handler via callback form", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "message",
          channel_type: "im",
          user: "U-random",
          text: "Hello",
          ts: uniqueId("ts"),
          channel: "D-test",
          event_ts: uniqueId("ts"),
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      await POST(request);

      expect(nextAfterArgForms).toEqual(["fn"]);
    });

    it("registers app_home_opened (home) handler via callback form", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_home_opened",
          user: "U-random",
          tab: "home",
          channel: "D-test",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      await POST(request);

      expect(nextAfterArgForms).toEqual(["fn"]);
    });

    it("registers app_home_opened (messages) handler via callback form", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_home_opened",
          user: "U-random",
          tab: "messages",
          channel: "D-test",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      await POST(request);

      expect(nextAfterArgForms).toEqual(["fn"]);
    });

    it("registers app_uninstalled cleanup via callback form", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: { type: "app_uninstalled" },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      await POST(request);

      expect(nextAfterArgForms).toEqual(["fn"]);
    });

    it("registers tokens_revoked cleanup via callback form", async () => {
      const workspaceId = uniqueId("T-ws");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "tokens_revoked",
          tokens: { bot: ["xoxb-revoked"] },
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      await POST(request);

      expect(nextAfterArgForms).toEqual(["fn"]);
    });
  });

  /**
   * End-to-end coverage for per-user agent overrides added in #9788 / #9795.
   *
   * These tests wire `handleOrgMention` through the HTTP route and force the
   * pre-dispatch error branch (by clearing the agent's head version) so the
   * handler posts a response. Asserting the presence / absence of the
   * "Sent via <agent>" footer on that response is how we verify two things
   * simultaneously:
   *
   *   1. `resolveEffectiveComposeId` actually routes the mention through the
   *      user's override agent instead of the org default. Without this
   *      wiring, the pre-dispatch error would reference the default agent and
   *      no footer would appear.
   *   2. `postPreDispatchErrorReply` correctly appends the footer only when
   *      the effective compose differs from the org default — the
   *      user-visible signal that "this reply came from your personal agent,
   *      not the org default".
   *
   * These scenarios are unreachable from `commands/__tests__/route.test.ts`
   * and `interactive/__tests__/route.test.ts`, which only exercise the modal
   * and DB persistence paths.
   */
  describe("app_mention — per-user agent override routing", () => {
    async function setupOrgWithOverride(opts: {
      overrideToAlternate: boolean;
      clearAlternate: boolean;
      clearDefault: boolean;
    }) {
      // Default agent — used when the user has no override.
      const defaultCompose = await createTestCompose(uniqueId("default"));
      await updateOrgDefaultAgent(user.orgId, defaultCompose.agentId);
      if (opts.clearDefault) {
        await clearComposeHeadVersion(defaultCompose.composeId);
      }

      // Alternate agent — the target of the user's override.
      const alternate = await createTestCompose(uniqueId("alt"));
      if (opts.clearAlternate) {
        await clearComposeHeadVersion(alternate.composeId);
      }

      if (opts.overrideToAlternate) {
        await seedSlackUserAgentPreference({
          vm0UserId: user.userId,
          orgId: user.orgId,
          composeId: alternate.composeId,
        });
      }

      const workspaceId = uniqueId("T-ws");
      const slackUserId = uniqueId("U-slack");
      await createTestSlackOrgInstallation({ workspaceId, orgId: user.orgId });
      await seedTestSlackOrgConnection({
        slackUserId,
        slackWorkspaceId: workspaceId,
        vm0UserId: user.userId,
      });

      return {
        workspaceId,
        slackUserId,
        defaultCompose,
        alternate,
      };
    }

    it("routes the mention through the override agent and appends 'Sent via <agent>' on pre-dispatch error", async () => {
      // Scenario: user has set a per-user override to an alternate agent. We
      // clear the alternate's head version so dispatch fails pre-run. The
      // handler should post the error message with a "Sent via <alternate>"
      // footer, proving both that the override is honored AND that the
      // footer surfaces which agent produced the reply.
      const { workspaceId, slackUserId, alternate } =
        await setupOrgWithOverride({
          overrideToAlternate: true,
          clearAlternate: true,
          clearDefault: false,
        });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_mention",
          user: slackUserId,
          text: "Hello agent",
          ts: "2000.001",
          channel: "C-test",
          event_ts: "2000.001",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();
      const callArg = (mockClient.chat.postMessage as ReturnType<typeof vi.fn>)
        .mock.calls[0]?.[0] as {
        blocks?: unknown;
      };
      const serialized = JSON.stringify(callArg?.blocks ?? "");
      // Footer uses the alternate agent's name (agent.displayName ?? agent.name).
      // createTestCompose uses the provided agentName, so `alternate.name` matches.
      expect(serialized).toContain(`Sent via ${alternate.name}`);
    });

    it("does NOT append the 'Sent via' footer when the user has no override (default agent path)", async () => {
      // Scenario: no user override — the mention should flow through the org
      // default agent and the error reply should NOT carry a footer (that
      // footer is reserved for replies from a non-default agent, so users
      // can tell when their personal override produced the reply).
      const { workspaceId, slackUserId } = await setupOrgWithOverride({
        overrideToAlternate: false,
        clearAlternate: false,
        clearDefault: true,
      });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_mention",
          user: slackUserId,
          text: "Hello agent",
          ts: "2000.002",
          channel: "C-test",
          event_ts: "2000.002",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();
      const callArg = (mockClient.chat.postMessage as ReturnType<typeof vi.fn>)
        .mock.calls[0]?.[0] as {
        blocks?: unknown;
      };
      const serialized = JSON.stringify(callArg?.blocks ?? "");
      expect(serialized).not.toContain("Sent via");
    });

    it("honors the user's override even when unrelated feature switches return false", async () => {
      mockIsFeatureEnabled.mockReturnValue(false);

      const { workspaceId, slackUserId, alternate } =
        await setupOrgWithOverride({
          overrideToAlternate: true,
          clearAlternate: true,
          clearDefault: false,
        });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_mention",
          user: slackUserId,
          text: "Hello agent",
          ts: "2000.003",
          channel: "C-test",
          event_ts: "2000.003",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();
      const callArg = (mockClient.chat.postMessage as ReturnType<typeof vi.fn>)
        .mock.calls[0]?.[0] as {
        blocks?: unknown;
      };
      const serialized = JSON.stringify(callArg?.blocks ?? "");
      expect(serialized).toContain(`Sent via ${alternate.name}`);
    });

    it("falls back to the org default when the override points to a compose without a zero_agents row (stale override guard)", async () => {
      // Scenario: the user's persisted override points to a compose that no
      // longer has a corresponding `zero_agents` row (e.g. the agent was
      // deleted or its zero_agents row was cleaned up out-of-band). The FK
      // from `slack_user_agent_preferences.selected_compose_id` to
      // `agent_composes.id` still holds, so the override row is present in
      // the DB, but the guard in `resolveEffectiveComposeId` —
      //   SELECT ... FROM zero_agents
      //   WHERE id = override AND org_id = user.org_id
      // — returns no row and the function must fall back to the org default.
      // This is the exact semantic the guard protects against.
      //
      // We use `seedOrphanCompose` to create a compose row without a
      // zero_agents row, then seed the preference pointing at that id. The
      // default agent's head version is cleared so the mention lands on the
      // pre-dispatch error branch we can assert against; the absence of a
      // "Sent via" footer proves the default (not the stale override) was
      // used.
      const orphan = await seedOrphanCompose({
        userId: user.userId,
        name: uniqueId("stale-override"),
        orgId: user.orgId,
      });

      const { workspaceId, slackUserId } = await setupOrgWithOverride({
        overrideToAlternate: false,
        clearAlternate: false,
        clearDefault: true,
      });

      await seedSlackUserAgentPreference({
        vm0UserId: user.userId,
        orgId: user.orgId,
        composeId: orphan.composeId,
      });

      const request = createSlackEventRequest({
        type: "event_callback",
        team_id: workspaceId,
        event: {
          type: "app_mention",
          user: slackUserId,
          text: "Hello agent",
          ts: "2000.004",
          channel: "C-test",
          event_ts: "2000.004",
        },
        event_id: uniqueId("evt"),
        event_time: Date.now(),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      const { WebClient } = await import("@slack/web-api");
      const mockClient = new WebClient();
      expect(mockClient.chat.postMessage).toHaveBeenCalledOnce();
      const callArg = (mockClient.chat.postMessage as ReturnType<typeof vi.fn>)
        .mock.calls[0]?.[0] as {
        blocks?: unknown;
      };
      const serialized = JSON.stringify(callArg?.blocks ?? "");
      expect(serialized).not.toContain("Sent via");
    });
  });
});
