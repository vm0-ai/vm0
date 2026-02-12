import crypto from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebClient } from "@slack/web-api";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import {
  givenLinkedSlackUser,
  givenSlackWorkspaceInstalled,
  givenUserHasAgent,
  givenWorkspaceAgentUnavailable,
} from "../../../../../src/__tests__/slack/api-helpers";
import { POST } from "../route";
import {
  createTestAgentSession,
  createTestThreadSession,
} from "../../../../../src/__tests__/api-test-helpers";
import * as runAgentModule from "../../../../../src/lib/slack/handlers/run-agent";

// Mock Next.js after() to execute synchronously instead of deferring
const afterPromises: Promise<unknown>[] = [];
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return {
    ...original,
    after: (promise: Promise<unknown>) => {
      afterPromises.push(promise);
    },
  };
});

/** Wait for all after() callbacks to complete */
async function flushAfterCallbacks() {
  await Promise.all(afterPromises);
  afterPromises.length = 0;
}

const context = testContext();

const TEST_SIGNING_SECRET = "test-slack-signing-secret";

/** Create a signed Slack event request */
function createSlackEventRequest(event: {
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs?: string;
}): Request {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = {
    type: "event_callback",
    token: "test-token",
    team_id: event.teamId,
    api_app_id: "A123",
    event: {
      type: "app_mention",
      user: event.userId,
      text: event.text,
      ts: event.ts,
      channel: event.channelId,
      event_ts: event.ts,
      ...(event.threadTs && { thread_ts: event.threadTs }),
    },
    event_id: "Ev123",
    event_time: parseInt(timestamp),
  };
  const body = JSON.stringify(payload);

  // Generate signature
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac("sha256", TEST_SIGNING_SECRET);
  const signature = `v0=${hmac.update(baseString).digest("hex")}`;

  return new Request("http://localhost/api/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body,
  });
}

/** Create a signed Slack DM event request */
function createSlackDmEventRequest(event: {
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs?: string;
  subtype?: string;
  botId?: string;
}): Request {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = {
    type: "event_callback",
    token: "test-token",
    team_id: event.teamId,
    api_app_id: "A123",
    event: {
      type: "message",
      channel_type: "im",
      user: event.userId,
      text: event.text,
      ts: event.ts,
      channel: event.channelId,
      event_ts: event.ts,
      ...(event.threadTs && { thread_ts: event.threadTs }),
      ...(event.subtype && { subtype: event.subtype }),
      ...(event.botId && { bot_id: event.botId }),
    },
    event_id: "Ev456",
    event_time: parseInt(timestamp),
  };
  const body = JSON.stringify(payload);

  // Generate signature
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac("sha256", TEST_SIGNING_SECRET);
  const signature = `v0=${hmac.update(baseString).digest("hex")}`;

  return new Request("http://localhost/api/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body,
  });
}

/** Create a signed Slack app_home_opened event request */
function createSlackAppHomeOpenedRequest(event: {
  teamId: string;
  userId: string;
  tab?: "home" | "messages";
  channelId?: string;
}): Request {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = {
    type: "event_callback",
    token: "test-token",
    team_id: event.teamId,
    api_app_id: "A123",
    event: {
      type: "app_home_opened",
      user: event.userId,
      tab: event.tab ?? "home",
      channel: event.channelId ?? "D000",
    },
    event_id: "Ev789",
    event_time: parseInt(timestamp),
  };
  const body = JSON.stringify(payload);

  // Generate signature
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac("sha256", TEST_SIGNING_SECRET);
  const signature = `v0=${hmac.update(baseString).digest("hex")}`;

  return new Request("http://localhost/api/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body,
  });
}

// Get the WebClient mock singleton (same object returned by every `new WebClient()`)
const mockClient = vi.mocked(new WebClient(), true);

/** Helper to read call arguments from a mock function */
function getCallArgs(
  mock: { mock: { calls: unknown[][] } },
  callIndex = 0,
): Record<string, unknown> {
  return (mock.mock.calls[callIndex]?.[0] ?? {}) as Record<string, unknown>;
}

describe("POST /api/slack/events", () => {
  beforeEach(() => {
    // Clear pending after() promises from previous tests to prevent cross-test pollution
    afterPromises.length = 0;

    context.setupMocks();

    // Clear viewsPublish mock so each test starts with a clean call count
    mockClient.views.publish.mockClear();

    // Default mock for runAgentForSlack — returns a dispatched result.
    // Individual tests can override via mockResolvedValueOnce.
    // Note: With the callback-based architecture, "dispatched" means the run was
    // successfully started and a callback will handle the response later.
    vi.spyOn(runAgentModule, "runAgentForSlack").mockResolvedValue({
      status: "dispatched",
      runId: "run-123",
    });
  });

  describe("Scenario: Mention bot as unlinked user", () => {
    it("should post ephemeral login prompt when user is not linked", async () => {
      // Given I am a Slack user without a linked account
      const { installation } = await givenSlackWorkspaceInstalled();

      // When I @mention the VM0 bot via the events API
      const request = createSlackEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId: "C123",
        userId: "U-unlinked-user",
        text: "<@BOT123> help me",
        ts: "1234567890.123456",
      });
      const response = await POST(request);

      // Then the route should return 200 OK
      expect(response.status).toBe(200);

      // Wait for after() callbacks to complete
      await flushAfterCallbacks();

      // And the ephemeral login prompt should be posted
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledTimes(1);

      const call = getCallArgs(mockClient.chat.postEphemeral);
      expect(call.channel).toBe("C123");
      expect(call.user).toBe("U-unlinked-user");

      // Check that blocks contain login URL with channel parameter
      const blocks = (call.blocks ?? []) as Array<{
        type: string;
        elements?: Array<{ url?: string }>;
      }>;
      const loginButton = blocks
        .flatMap((block) =>
          block.type === "actions" ? (block.elements ?? []) : [],
        )
        .find((e) => e.url?.includes("/slack/connect"));

      expect(loginButton).toBeDefined();
      expect(loginButton!.url).toContain("c=C123"); // Channel ID included for success message
    });

    it("should not include thread_ts in ephemeral login prompt (even when mentioned in thread)", async () => {
      // Given I am a Slack user without a linked account
      const { installation } = await givenSlackWorkspaceInstalled();

      // When I @mention the VM0 bot in a thread
      const request = createSlackEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId: "C123",
        userId: "U-unlinked-user",
        text: "<@BOT123> help me",
        ts: "1234567890.123456",
        threadTs: "1234567890.000000", // This is a thread reply
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then the ephemeral message should NOT include thread_ts
      // (Slack ephemeral messages with thread_ts don't display correctly)
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledTimes(1);

      const call = getCallArgs(mockClient.chat.postEphemeral);
      expect(call.thread_ts).toBeUndefined();
    });
  });

  describe("Scenario: Mention bot with unavailable workspace agent", () => {
    it("should inform user the workspace agent is not available", async () => {
      // Given I am a linked Slack user whose workspace agent is unavailable
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenWorkspaceAgentUnavailable(installation.slackWorkspaceId);

      // When I @mention the VM0 bot
      const request = createSlackEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId: "C123",
        userId: userLink.slackUserId,
        text: `<@${installation.botUserId}> help me`,
        ts: "1234567890.123456",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then I should receive a message saying the workspace agent is not available
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);

      const call = getCallArgs(mockClient.chat.postMessage);
      const text = (call.text as string) ?? "";
      expect(text).toContain("workspace agent is not available");
    });
  });

  describe("Scenario: Mention bot with single agent", () => {
    it("should dispatch agent run and add thinking reaction", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });

      // When I @mention the VM0 bot
      const request = createSlackEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId: "C123",
        userId: userLink.slackUserId,
        text: `<@${installation.botUserId}> help me with this code`,
        ts: "1234567890.123456",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then:
      // 1. Thinking reaction should be added
      expect(mockClient.reactions.add).toHaveBeenCalledTimes(1);
      const reactionCall = getCallArgs(mockClient.reactions.add);
      expect(reactionCall.name).toBe("thought_balloon");

      // 2. No response message should be posted yet (callback handles that)
      // The handler returns immediately after dispatching the run
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();

      // 3. Thinking reaction should NOT be removed yet (callback handles that)
      expect(mockClient.reactions.remove).not.toHaveBeenCalled();
    });

    it("should post error and remove reaction when dispatch fails", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });

      // And runAgentForSlack returns a failed result (dispatch failure)
      vi.spyOn(runAgentModule, "runAgentForSlack").mockResolvedValueOnce({
        status: "failed",
        response: "Error: Agent execution failed.",
        runId: undefined,
      });

      // When I @mention the VM0 bot
      const request = createSlackEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId: "C123",
        userId: userLink.slackUserId,
        text: `<@${installation.botUserId}> help me with this code`,
        ts: "1234567890.123456",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then the response should contain an error message
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const call = getCallArgs(mockClient.chat.postMessage);
      const text = (call.text as string) ?? "";
      expect(text).toContain("Error");

      // And the thinking reaction should be removed (since callback won't be invoked)
      expect(mockClient.reactions.remove).toHaveBeenCalledTimes(1);
    });
  });

  describe("Scenario: Installation not found", () => {
    it("should handle gracefully when workspace is not installed", async () => {
      // Given workspace is not installed (no installation record)
      // When event is received for unknown workspace
      const request = createSlackEventRequest({
        teamId: "T-unknown-workspace",
        channelId: "C123",
        userId: "U123",
        text: "<@BOT123> help me",
        ts: "1234567890.123456",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then no messages should be sent (silent failure)
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });
  });

  describe("Scenario: DM bot as unlinked user", () => {
    it("should post login prompt as direct message (not ephemeral)", async () => {
      // Given I am a Slack user without a linked account
      const { installation } = await givenSlackWorkspaceInstalled();

      // When I send a DM to the bot
      const request = createSlackDmEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId: "D123",
        userId: "U-unlinked-user",
        text: "hello",
        ts: "1234567890.123456",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then the login prompt should be posted as a direct message (not ephemeral)
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(mockClient.chat.postEphemeral).not.toHaveBeenCalled();

      const call = getCallArgs(mockClient.chat.postMessage);
      expect(call.channel).toBe("D123");

      // Check that blocks contain login URL
      const blocks = (call.blocks ?? []) as Array<{
        type: string;
        elements?: Array<{ url?: string }>;
      }>;
      const loginButton = blocks
        .flatMap((block) =>
          block.type === "actions" ? (block.elements ?? []) : [],
        )
        .find((e) => e.url?.includes("/slack/connect"));

      expect(loginButton).toBeDefined();
    });
  });

  describe("Scenario: DM bot with unavailable workspace agent", () => {
    it("should inform user the workspace agent is not available", async () => {
      // Given I am a linked Slack user whose workspace agent is unavailable
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenWorkspaceAgentUnavailable(installation.slackWorkspaceId);

      // When I send a DM to the bot
      const request = createSlackDmEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId: "D123",
        userId: userLink.slackUserId,
        text: "help me",
        ts: "1234567890.123456",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then I should receive a message saying the workspace agent is not available
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);

      const call = getCallArgs(mockClient.chat.postMessage);
      const text = (call.text as string) ?? "";
      expect(text).toContain("workspace agent is not available");
    });
  });

  describe("Scenario: DM bot with single agent", () => {
    it("should dispatch agent run and add thinking reaction", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });

      // When I send a DM to the bot
      const request = createSlackDmEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId: "D123",
        userId: userLink.slackUserId,
        text: "help me with this code",
        ts: "1234567890.123456",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then:
      // 1. Thinking reaction should be added
      expect(mockClient.reactions.add).toHaveBeenCalledTimes(1);

      // 2. No response message should be posted yet (callback handles that)
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();

      // 3. Thinking reaction should NOT be removed yet (callback handles that)
      expect(mockClient.reactions.remove).not.toHaveBeenCalled();
    });

    it("should post error and remove reaction when dispatch fails", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });

      // And runAgentForSlack returns a failed result (dispatch failure)
      vi.spyOn(runAgentModule, "runAgentForSlack").mockResolvedValueOnce({
        status: "failed",
        response: "Error: Agent execution failed.",
        runId: undefined,
      });

      // When I send a DM to the bot
      const request = createSlackDmEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId: "D123",
        userId: userLink.slackUserId,
        text: "help me with this code",
        ts: "1234567890.123456",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then the response should contain an error message
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const call = getCallArgs(mockClient.chat.postMessage);
      const text = (call.text as string) ?? "";
      expect(text).toContain("Error");

      // And the thinking reaction should be removed
      expect(mockClient.reactions.remove).toHaveBeenCalledTimes(1);
    });
  });

  describe("Scenario: DM bot with greeting message", () => {
    it("should dispatch agent run for greeting (not show welcome card)", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });

      // And runAgentForSlack is mocked to track the call
      const runAgentSpy = vi
        .spyOn(runAgentModule, "runAgentForSlack")
        .mockResolvedValueOnce({
          status: "dispatched",
          runId: "test-run-id",
        });

      // When I send "hello" in DM (a greeting that triggers not_request in mentions)
      const request = createSlackDmEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId: "D123",
        userId: userLink.slackUserId,
        text: "hello",
        ts: "1234567890.123456",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then the message should be routed to the agent (runAgentForSlack called)
      expect(runAgentSpy).toHaveBeenCalledTimes(1);
      expect(runAgentSpy.mock.calls[0]![0].prompt).toBe("hello");

      // And no immediate response should be posted (callback handles that)
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });
  });

  describe("Scenario: DM from bot (loop prevention)", () => {
    it("should silently ignore messages with bot_id", async () => {
      const { installation } = await givenSlackWorkspaceInstalled();

      // When a bot message event arrives (has bot_id)
      const request = createSlackDmEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId: "D123",
        userId: "U123",
        text: "I am a bot reply",
        ts: "1234567890.123456",
        botId: "B999",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then no handler should be called (message silently ignored at route level)
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
      expect(mockClient.chat.postEphemeral).not.toHaveBeenCalled();
    });
  });

  describe("Scenario: DM with subtype (e.g. message_changed)", () => {
    it("should silently ignore messages with subtype", async () => {
      const { installation } = await givenSlackWorkspaceInstalled();

      // When a message_changed event arrives (has subtype)
      const request = createSlackDmEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId: "D123",
        userId: "U123",
        text: "edited message",
        ts: "1234567890.123456",
        subtype: "message_changed",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then no handler should be called (message silently ignored at route level)
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
      expect(mockClient.chat.postEphemeral).not.toHaveBeenCalled();
    });
  });

  describe("Scenario: App Home opened by unlinked user", () => {
    it("should publish home view with login prompt", async () => {
      // Given I am a Slack user without a linked account
      const { installation } = await givenSlackWorkspaceInstalled();

      // Clear viewsPublish calls from givenSlackWorkspaceInstalled
      mockClient.views.publish.mockClear();

      // When I open the bot's Home tab
      const request = createSlackAppHomeOpenedRequest({
        teamId: installation.slackWorkspaceId,
        userId: "U-unlinked-user",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then the home view should be published with login prompt
      expect(mockClient.views.publish).toHaveBeenCalledTimes(1);

      const call = getCallArgs(mockClient.views.publish);
      expect(call.user_id).toBe("U-unlinked-user");

      // View should contain "not connected" and a login button
      const view = (call.view ?? {}) as {
        type: string;
        blocks: Array<{
          type: string;
          text?: { text: string };
          elements?: Array<{ action_id?: string; url?: string }>;
        }>;
      };
      expect(view.type).toBe("home");
      const texts = view.blocks
        .filter(
          (b): b is { type: string; text: { text: string } } =>
            b.type === "section" && !!b.text,
        )
        .map((b) => b.text.text);
      expect(texts.some((t) => t.includes("not connected"))).toBe(true);
    });
  });

  describe("Scenario: App Home opened by linked user with agent", () => {
    it("should publish home view with agent list", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });
      // Clear viewsPublish calls from givenUserHasAgent (which refreshes
      // App Home after linking) so we can assert on only the test's call.
      mockClient.views.publish.mockClear();

      // When I open the bot's Home tab
      const request = createSlackAppHomeOpenedRequest({
        teamId: installation.slackWorkspaceId,
        userId: userLink.slackUserId,
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then the home view should be published with agent info
      expect(mockClient.views.publish).toHaveBeenCalledTimes(1);

      const call = getCallArgs(mockClient.views.publish);
      expect(call.user_id).toBe(userLink.slackUserId);

      const view = (call.view ?? {}) as {
        type: string;
        blocks: Array<{
          type: string;
          text?: { text: string };
          elements?: Array<{ action_id?: string }>;
        }>;
      };
      expect(view.type).toBe("home");
      const texts = view.blocks
        .filter(
          (b): b is { type: string; text: { text: string } } =>
            b.type === "section" && !!b.text,
        )
        .map((b) => b.text.text);
      expect(texts.some((t) => t.includes("Connected to VM0"))).toBe(true);
      expect(texts.some((t) => t.includes("my-helper"))).toBe(true);

      // Disconnect button should be present
      const disconnectBlock = view.blocks.find(
        (b) =>
          b.type === "section" &&
          b.text?.text.includes("Disconnect VM0 Account"),
      );
      expect(disconnectBlock).toBeDefined();
    });
  });

  describe("Scenario: App Home opened by linked user with default workspace agent", () => {
    it("should publish home view with workspace agent info", async () => {
      // Given I am a linked Slack user (workspace always has a default agent)
      const { userLink, installation } = await givenLinkedSlackUser();

      // Clear viewsPublish calls from givenLinkedSlackUser (which refreshes
      // App Home after linking) so we can assert on only the test's call.
      mockClient.views.publish.mockClear();

      // When I open the bot's Home tab
      const request = createSlackAppHomeOpenedRequest({
        teamId: installation.slackWorkspaceId,
        userId: userLink.slackUserId,
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then the home view should be published with workspace agent info
      expect(mockClient.views.publish).toHaveBeenCalledTimes(1);

      const call = getCallArgs(mockClient.views.publish);
      const view = (call.view ?? {}) as {
        type: string;
        blocks: Array<{
          type: string;
          text?: { text: string };
        }>;
      };
      expect(view.type).toBe("home");
      const texts = view.blocks
        .filter(
          (b): b is { type: string; text: { text: string } } =>
            b.type === "section" && !!b.text,
        )
        .map((b) => b.text.text);
      expect(texts.some((t) => t.includes("Connected to VM0"))).toBe(true);
      // Workspace always has a default agent — verify the agent name is shown
      expect(texts.some((t) => t.includes("default-agent"))).toBe(true);
    });
  });

  describe("Scenario: Messages tab opened by linked user with agent", () => {
    it("should send welcome message with agent info", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });

      // Clear postMessage mock so we only capture this test's calls
      mockClient.chat.postMessage.mockClear();

      // When I open the Messages tab
      const request = createSlackAppHomeOpenedRequest({
        teamId: installation.slackWorkspaceId,
        userId: userLink.slackUserId,
        tab: "messages",
        channelId: "D-dm-channel",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then a welcome message should be posted
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);

      const call = getCallArgs(mockClient.chat.postMessage);
      expect(call.channel).toBe("D-dm-channel");

      // Blocks should include agent info
      const blocks = (call.blocks ?? []) as Array<{
        type: string;
        text?: { text: string };
      }>;
      const texts = blocks
        .filter(
          (b): b is { type: string; text: { text: string } } =>
            b.type === "section" && !!b.text,
        )
        .map((b) => b.text.text);
      expect(texts.some((t) => t.includes("my-helper"))).toBe(true);
    });
  });

  describe("Scenario: Messages tab opened a second time (no duplicate)", () => {
    it("should not send welcome message again", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });

      // Clear postMessage mock so we only capture this test's calls
      mockClient.chat.postMessage.mockClear();

      // When I open the Messages tab the first time
      const request1 = createSlackAppHomeOpenedRequest({
        teamId: installation.slackWorkspaceId,
        userId: userLink.slackUserId,
        tab: "messages",
        channelId: "D-dm-channel",
      });
      await POST(request1);
      await flushAfterCallbacks();

      // Then the welcome message should be sent once
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);

      // When I open the Messages tab again
      mockClient.chat.postMessage.mockClear();
      const request2 = createSlackAppHomeOpenedRequest({
        teamId: installation.slackWorkspaceId,
        userId: userLink.slackUserId,
        tab: "messages",
        channelId: "D-dm-channel",
      });
      await POST(request2);
      await flushAfterCallbacks();

      // Then no duplicate message should be sent
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });
  });

  describe("Scenario: Context deduplication across thread turns", () => {
    it("should send only new messages on second turn in same thread", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });

      // Use unique channel/thread IDs to avoid collisions with stale DB data
      const channelId = `C-dedup-${Date.now()}`;
      const threadTs = "1000000000.000000";

      // Create an agent session so the FK constraint is satisfied
      await createTestAgentSession(userLink.vm0UserId, binding.composeId);

      // And runAgentForSlack returns a dispatched result
      const runAgentSpy = vi
        .spyOn(runAgentModule, "runAgentForSlack")
        .mockResolvedValue({
          status: "dispatched",
          runId: "test-run-id",
        });

      // And the thread has 2 messages
      mockClient.conversations.replies.mockResolvedValueOnce({
        ok: true,
        messages: [
          { user: "U111", text: "First message", ts: "1000000000.000000" },
          {
            user: userLink.slackUserId,
            text: "Second message",
            ts: "1000000001.000000",
          },
        ],
      } as never);

      // When I send the first mention in a thread
      const request1 = createSlackEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId,
        userId: userLink.slackUserId,
        text: `<@${installation.botUserId}> help me`,
        ts: "1000000001.000000",
        threadTs,
      });
      await POST(request1);
      await flushAfterCallbacks();

      // Then the agent should receive context excluding the current message
      // (current message is already sent as the prompt)
      expect(runAgentSpy).toHaveBeenCalledTimes(1);
      const firstCallContext = runAgentSpy.mock.calls[0]![0].threadContext;
      expect(firstCallContext).toContain("First message");
      expect(firstCallContext).not.toContain("Second message");

      // Note: With callback-based architecture, lastProcessedMessageTs is updated
      // by the callback endpoint, not by the handler. This test only verifies
      // the initial context sent to the agent.
    });
  });

  describe("Scenario: Reply in notification DM thread (NULL bindingId)", () => {
    it("should resolve agent from thread session and dispatch run", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "my-scheduled-agent",
      });

      // Use unique channel/thread IDs
      const channelId = `D-notif-${Date.now()}`;
      const threadTs = "3000000000.000000";

      // And an agent session exists for a previous scheduled run
      const agentSession = await createTestAgentSession(
        userLink.vm0UserId,
        binding.composeId,
      );

      // And a thread session exists (created by notification)
      await createTestThreadSession({
        userLinkId: userLink.id,
        channelId,
        threadTs,
        agentSessionId: agentSession.id,
        lastProcessedMessageTs: threadTs,
      });

      // And runAgentForSlack returns a dispatched result
      const runAgentSpy = vi
        .spyOn(runAgentModule, "runAgentForSlack")
        .mockResolvedValueOnce({
          status: "dispatched",
          runId: "test-run-id",
        });

      // And the thread has the notification message
      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.conversations.replies.mockResolvedValueOnce({
        ok: true,
        messages: [
          {
            bot_id: "B123",
            text: "Scheduled run completed",
            ts: threadTs,
          },
        ],
      } as never);

      // When I reply in the notification DM thread
      const request = createSlackDmEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId,
        userId: userLink.slackUserId,
        text: "tell me more about the results",
        ts: "3000000001.000000",
        threadTs,
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then the agent should be dispatched with the existing session
      expect(runAgentSpy).toHaveBeenCalledTimes(1);
      expect(runAgentSpy.mock.calls[0]![0].sessionId).toBe(agentSession.id);
      expect(runAgentSpy.mock.calls[0]![0].composeId).toBe(binding.composeId);

      // And Slack context should be skipped (session checkpoint has full history)
      expect(runAgentSpy.mock.calls[0]![0].threadContext).toBe("");

      // And no immediate response should be posted (callback handles that)
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });
  });

  describe("Scenario: Messages tab opened by unlinked user", () => {
    it("should not send any message", async () => {
      // Given I am a Slack user without a linked account
      const { installation } = await givenSlackWorkspaceInstalled();

      // When I open the Messages tab
      const request = createSlackAppHomeOpenedRequest({
        teamId: installation.slackWorkspaceId,
        userId: "U-unlinked-user",
        tab: "messages",
        channelId: "D-dm-channel",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then no message should be sent
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });
  });
});
