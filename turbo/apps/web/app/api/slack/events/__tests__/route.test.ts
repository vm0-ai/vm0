import crypto from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { server } from "../../../../../src/mocks/server";
import {
  givenLinkedSlackUser,
  givenSlackWorkspaceInstalled,
  givenUserHasAgent,
} from "../../../../../src/__tests__/slack/api-helpers";
import { handlers, http } from "../../../../../src/__tests__/msw";
import { POST } from "../route";
import { createTestAgentSession } from "../../../../../src/__tests__/api-test-helpers";
import * as runAgentModule from "../../../../../src/lib/slack/handlers/run-agent";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

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

const SLACK_API = "https://slack.com/api";

const slackHandlers = handlers({
  postMessage: http.post(
    `${SLACK_API}/chat.postMessage`,
    async ({ request }) => {
      const body = await request.formData();
      const data = Object.fromEntries(body.entries());
      return HttpResponse.json({
        ok: true,
        ts: `${Date.now()}.000000`,
        channel: data.channel,
      });
    },
  ),
  postEphemeral: http.post(`${SLACK_API}/chat.postEphemeral`, () =>
    HttpResponse.json({ ok: true, message_ts: `${Date.now()}.000000` }),
  ),
  chatUpdate: http.post(`${SLACK_API}/chat.update`, async ({ request }) => {
    const body = await request.formData();
    const data = Object.fromEntries(body.entries());
    return HttpResponse.json({ ok: true, ts: data.ts, channel: data.channel });
  }),
  reactionsAdd: http.post(`${SLACK_API}/reactions.add`, () =>
    HttpResponse.json({ ok: true }),
  ),
  reactionsRemove: http.post(`${SLACK_API}/reactions.remove`, () =>
    HttpResponse.json({ ok: true }),
  ),
  conversationsReplies: http.post(`${SLACK_API}/conversations.replies`, () =>
    HttpResponse.json({ ok: true, messages: [] }),
  ),
  conversationsHistory: http.post(`${SLACK_API}/conversations.history`, () =>
    HttpResponse.json({ ok: true, messages: [] }),
  ),
  viewsPublish: http.post(`${SLACK_API}/views.publish`, () =>
    HttpResponse.json({ ok: true }),
  ),
});

/** Helper to get form data from a mock's call */
async function getFormData(
  mock: { mock: { calls: Array<[{ request: Request }]> } },
  callIndex = 0,
): Promise<Record<string, FormDataEntryValue>> {
  const request = mock.mock.calls[callIndex]![0].request;
  const body = await request.formData();
  return Object.fromEntries(body.entries());
}

describe("POST /api/slack/events", () => {
  beforeEach(() => {
    context.setupMocks();
    server.use(...slackHandlers.handlers);

    // Clear viewsPublish mock so each test starts with a clean call count
    vi.mocked(slackHandlers.mocked.viewsPublish).mockClear();
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
      expect(slackHandlers.mocked.postEphemeral).toHaveBeenCalledTimes(1);

      const data = await getFormData(slackHandlers.mocked.postEphemeral);
      expect(data.channel).toBe("C123");
      expect(data.user).toBe("U-unlinked-user");

      // Check that blocks contain login URL with channel parameter
      const blocks = JSON.parse((data.blocks as string) ?? "[]");
      const loginButton = blocks
        .flatMap(
          (block: { type: string; elements?: Array<{ url?: string }> }) =>
            block.type === "actions" ? (block.elements ?? []) : [],
        )
        .find((e: { url?: string }) => e.url?.includes("/slack/link"));

      expect(loginButton).toBeDefined();
      expect(loginButton.url).toContain("c=C123"); // Channel ID included for success message
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
      expect(slackHandlers.mocked.postEphemeral).toHaveBeenCalledTimes(1);

      const data = await getFormData(slackHandlers.mocked.postEphemeral);
      expect(data.thread_ts).toBeUndefined();
    });
  });

  describe("Scenario: Mention bot with no agents", () => {
    it("should prompt user to add an agent", async () => {
      // Given I am a linked Slack user with no agents
      const { userLink, installation } = await givenLinkedSlackUser();

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

      // Then I should receive a message prompting to link an agent
      expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);

      const data = await getFormData(slackHandlers.mocked.postMessage);
      const text = (data.text as string) ?? "";
      expect(text).toContain("don't have any agent linked");
      expect(text).toContain("/vm0 agent link");
    });
  });

  describe("Scenario: Mention bot with single agent", () => {
    it("should execute agent and post response", async () => {
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
      expect(slackHandlers.mocked.reactionsAdd).toHaveBeenCalledTimes(1);
      const reactionData = await getFormData(slackHandlers.mocked.reactionsAdd);
      expect(reactionData.name).toBe("thought_balloon");

      // 2. Response message should be posted
      expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);

      // 3. Response should include agent name in context block
      const data = await getFormData(slackHandlers.mocked.postMessage);
      const blocks = JSON.parse((data.blocks as string) ?? "[]") as Array<{
        type: string;
        elements?: Array<{ text?: string }>;
      }>;
      const contextBlocks = blocks.filter((b) => b.type === "context");
      expect(contextBlocks.length).toBeGreaterThanOrEqual(1);
      const agentContext = contextBlocks[0]!.elements?.[0]?.text;
      expect(agentContext).toContain("my-helper");

      // 4. Thinking reaction should be removed
      expect(slackHandlers.mocked.reactionsRemove).toHaveBeenCalledTimes(1);
    });

    it("should not include timeout warning prefix when agent fails", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });

      // When I @mention the VM0 bot (agent will fail due to test environment)
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

      // Then the response should contain an error message (failed status)
      expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);
      const data = await getFormData(slackHandlers.mocked.postMessage);
      const text = (data.text as string) ?? "";
      expect(text).toContain("Error");

      // And the response should NOT include the timeout warning prefix
      // (timeout prefix ":warning: *Agent timed out*" is only added for timeout status)
      expect(text).not.toContain(":warning:");
      expect(text).not.toContain("Agent timed out");

      // And the blocks should also not contain timeout warning
      const blocks = JSON.parse((data.blocks as string) ?? "[]") as Array<{
        type: string;
        text?: { text?: string };
      }>;
      const sectionTexts = blocks
        .filter((b) => b.type === "section")
        .map((b) => b.text?.text ?? "")
        .join("");
      expect(sectionTexts).not.toContain(":warning:");
      expect(sectionTexts).not.toContain("Agent timed out");
    });

    it("should include timeout warning prefix when agent times out", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });

      // And runAgentForSlack returns a timeout result
      vi.spyOn(runAgentModule, "runAgentForSlack").mockResolvedValueOnce({
        status: "timeout",
        response:
          "The agent timed out after 30 minutes. You can check the logs for more details.",
        sessionId: undefined,
        runId: "test-run-id",
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

      // Then the response should include the timeout warning prefix
      expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);
      const data = await getFormData(slackHandlers.mocked.postMessage);
      const text = (data.text as string) ?? "";
      expect(text).toContain(":warning:");
      expect(text).toContain("Agent timed out");
      expect(text).toContain("timed out after 30 minutes");

      // And the blocks should contain the agent name and logs link
      const blocks = JSON.parse((data.blocks as string) ?? "[]") as Array<{
        type: string;
        elements?: Array<{ text?: string }>;
      }>;
      const contextBlocks = blocks.filter((b) => b.type === "context");
      // First context block: agent name
      expect(contextBlocks[0]!.elements?.[0]?.text).toContain("my-helper");
      // Last context block: logs link
      const logsBlock = contextBlocks[contextBlocks.length - 1]!;
      expect(logsBlock.elements?.[0]?.text).toContain("test-run-id");

      // And the thinking reaction should still be removed
      expect(slackHandlers.mocked.reactionsRemove).toHaveBeenCalledTimes(1);
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
      expect(slackHandlers.mocked.postMessage).not.toHaveBeenCalled();
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
      expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);
      expect(slackHandlers.mocked.postEphemeral).not.toHaveBeenCalled();

      const data = await getFormData(slackHandlers.mocked.postMessage);
      expect(data.channel).toBe("D123");

      // Check that blocks contain login URL
      const blocks = JSON.parse((data.blocks as string) ?? "[]");
      const loginButton = blocks
        .flatMap(
          (block: { type: string; elements?: Array<{ url?: string }> }) =>
            block.type === "actions" ? (block.elements ?? []) : [],
        )
        .find((e: { url?: string }) => e.url?.includes("/slack/link"));

      expect(loginButton).toBeDefined();
    });
  });

  describe("Scenario: DM bot with no agents", () => {
    it("should prompt user to link an agent", async () => {
      // Given I am a linked Slack user with no agents
      const { userLink, installation } = await givenLinkedSlackUser();

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

      // Then I should receive a message prompting to link an agent
      expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);

      const data = await getFormData(slackHandlers.mocked.postMessage);
      const text = (data.text as string) ?? "";
      expect(text).toContain("don't have any agent linked");
      expect(text).toContain("/vm0 agent link");
    });
  });

  describe("Scenario: DM bot with single agent", () => {
    it("should execute agent and post response", async () => {
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
      expect(slackHandlers.mocked.reactionsAdd).toHaveBeenCalledTimes(1);

      // 2. Response message should be posted
      expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);

      // 3. Response should include agent name in context block
      const data = await getFormData(slackHandlers.mocked.postMessage);
      const blocks = JSON.parse((data.blocks as string) ?? "[]") as Array<{
        type: string;
        elements?: Array<{ text?: string }>;
      }>;
      const contextBlocks = blocks.filter((b) => b.type === "context");
      expect(contextBlocks.length).toBeGreaterThanOrEqual(1);
      const agentContext = contextBlocks[0]!.elements?.[0]?.text;
      expect(agentContext).toContain("my-helper");

      // 4. Thinking reaction should be removed
      expect(slackHandlers.mocked.reactionsRemove).toHaveBeenCalledTimes(1);
    });

    it("should not include timeout warning prefix when agent fails", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });

      // When I send a DM to the bot (agent will fail due to test environment)
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

      // Then the response should contain an error message (failed status)
      expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);
      const data = await getFormData(slackHandlers.mocked.postMessage);
      const text = (data.text as string) ?? "";
      expect(text).toContain("Error");

      // And the response should NOT include the timeout warning prefix
      expect(text).not.toContain(":warning:");
      expect(text).not.toContain("Agent timed out");
    });

    it("should include timeout warning prefix when agent times out", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });

      // And runAgentForSlack returns a timeout result
      vi.spyOn(runAgentModule, "runAgentForSlack").mockResolvedValueOnce({
        status: "timeout",
        response:
          "The agent timed out after 30 minutes. You can check the logs for more details.",
        sessionId: undefined,
        runId: "test-run-id",
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

      // Then the response should include the timeout warning prefix
      expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);
      const data = await getFormData(slackHandlers.mocked.postMessage);
      const text = (data.text as string) ?? "";
      expect(text).toContain(":warning:");
      expect(text).toContain("Agent timed out");
      expect(text).toContain("timed out after 30 minutes");

      // And the blocks should contain the agent name and logs link
      const blocks = JSON.parse((data.blocks as string) ?? "[]") as Array<{
        type: string;
        elements?: Array<{ text?: string }>;
      }>;
      const contextBlocks = blocks.filter((b) => b.type === "context");
      expect(contextBlocks[0]!.elements?.[0]?.text).toContain("my-helper");
      const logsBlock = contextBlocks[contextBlocks.length - 1]!;
      expect(logsBlock.elements?.[0]?.text).toContain("test-run-id");

      // And the thinking reaction should still be removed
      expect(slackHandlers.mocked.reactionsRemove).toHaveBeenCalledTimes(1);
    });
  });

  describe("Scenario: DM bot with greeting message", () => {
    it("should route greeting to agent instead of showing welcome card", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink, {
        agentName: "my-helper",
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

      // Then the message should be routed to the agent (not show welcome card)
      expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);

      const data = await getFormData(slackHandlers.mocked.postMessage);
      const blocks = JSON.parse((data.blocks as string) ?? "[]") as Array<{
        type: string;
        elements?: Array<{ text?: string }>;
      }>;
      const contextBlocks = blocks.filter((b) => b.type === "context");
      expect(contextBlocks.length).toBeGreaterThanOrEqual(1);
      // Agent name should be in the response (not a welcome card)
      const agentContext = contextBlocks[0]!.elements?.[0]?.text;
      expect(agentContext).toContain("my-helper");
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
      expect(slackHandlers.mocked.postMessage).not.toHaveBeenCalled();
      expect(slackHandlers.mocked.postEphemeral).not.toHaveBeenCalled();
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
      expect(slackHandlers.mocked.postMessage).not.toHaveBeenCalled();
      expect(slackHandlers.mocked.postEphemeral).not.toHaveBeenCalled();
    });
  });

  describe("Scenario: App Home opened by unlinked user", () => {
    it("should publish home view with login prompt", async () => {
      // Given I am a Slack user without a linked account
      const { installation } = await givenSlackWorkspaceInstalled();

      // When I open the bot's Home tab
      const request = createSlackAppHomeOpenedRequest({
        teamId: installation.slackWorkspaceId,
        userId: "U-unlinked-user",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then the home view should be published with login prompt
      expect(slackHandlers.mocked.viewsPublish).toHaveBeenCalledTimes(1);

      const data = await getFormData(slackHandlers.mocked.viewsPublish);
      expect(data.user_id).toBe("U-unlinked-user");

      // View should contain "not connected" and a login button
      const view = JSON.parse((data.view as string) ?? "{}") as {
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
      // Reset runtime handlers from givenUserHasAgent so the test's own
      // viewsPublish handler takes priority, then re-register test handlers.
      server.resetHandlers();
      server.use(...slackHandlers.handlers);
      vi.mocked(slackHandlers.mocked.viewsPublish).mockClear();

      // When I open the bot's Home tab
      const request = createSlackAppHomeOpenedRequest({
        teamId: installation.slackWorkspaceId,
        userId: userLink.slackUserId,
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then the home view should be published with agent info
      expect(slackHandlers.mocked.viewsPublish).toHaveBeenCalledTimes(1);

      const data = await getFormData(slackHandlers.mocked.viewsPublish);
      expect(data.user_id).toBe(userLink.slackUserId);

      const view = JSON.parse((data.view as string) ?? "{}") as {
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

  describe("Scenario: App Home opened by linked user without agents", () => {
    it("should publish home view with link prompt", async () => {
      // Given I am a linked Slack user with no agents
      const { userLink, installation } = await givenLinkedSlackUser();

      // Clear viewsPublish calls from givenLinkedSlackUser (which refreshes
      // App Home after linking) so we can assert on only the test's call.
      vi.mocked(slackHandlers.mocked.viewsPublish).mockClear();

      // When I open the bot's Home tab
      const request = createSlackAppHomeOpenedRequest({
        teamId: installation.slackWorkspaceId,
        userId: userLink.slackUserId,
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      await flushAfterCallbacks();

      // Then the home view should be published with link prompt
      expect(slackHandlers.mocked.viewsPublish).toHaveBeenCalledTimes(1);

      const data = await getFormData(slackHandlers.mocked.viewsPublish);
      const view = JSON.parse((data.view as string) ?? "{}") as {
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
      expect(texts.some((t) => t.includes("No agent linked yet"))).toBe(true);
    });
  });

  describe("Scenario: Messages tab opened by linked user with agent", () => {
    it("should send welcome message with agent info", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });

      // Reset and re-register test handlers
      server.resetHandlers();
      server.use(...slackHandlers.handlers);
      vi.mocked(slackHandlers.mocked.postMessage).mockClear();

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
      expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);

      const data = await getFormData(slackHandlers.mocked.postMessage);
      expect(data.channel).toBe("D-dm-channel");

      // Blocks should include agent info
      const blocks = JSON.parse((data.blocks as string) ?? "[]") as Array<{
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

      // Reset and re-register test handlers
      server.resetHandlers();
      server.use(...slackHandlers.handlers);
      vi.mocked(slackHandlers.mocked.postMessage).mockClear();

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
      expect(slackHandlers.mocked.postMessage).toHaveBeenCalledTimes(1);

      // When I open the Messages tab again
      vi.mocked(slackHandlers.mocked.postMessage).mockClear();
      const request2 = createSlackAppHomeOpenedRequest({
        teamId: installation.slackWorkspaceId,
        userId: userLink.slackUserId,
        tab: "messages",
        channelId: "D-dm-channel",
      });
      await POST(request2);
      await flushAfterCallbacks();

      // Then no duplicate message should be sent
      expect(slackHandlers.mocked.postMessage).not.toHaveBeenCalled();
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
      const agentSession = await createTestAgentSession(
        userLink.vm0UserId,
        binding.composeId,
      );

      // And runAgentForSlack returns a completed result with that session ID
      const runAgentSpy = vi
        .spyOn(runAgentModule, "runAgentForSlack")
        .mockResolvedValue({
          status: "completed",
          response: "Done!",
          sessionId: agentSession.id,
          runId: "test-run-id",
        });

      // And the thread has 2 messages
      const repliesHandler1 = http.post(
        "https://slack.com/api/conversations.replies",
        () =>
          HttpResponse.json({
            ok: true,
            messages: [
              { user: "U111", text: "First message", ts: "1000000000.000000" },
              {
                user: userLink.slackUserId,
                text: "Second message",
                ts: "1000000001.000000",
              },
            ],
          }),
      );
      server.use(repliesHandler1.handler);

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

      // Reset mocks for second turn
      runAgentSpy.mockClear();
      vi.mocked(slackHandlers.mocked.postMessage).mockClear();
      vi.mocked(slackHandlers.mocked.reactionsAdd).mockClear();
      vi.mocked(slackHandlers.mocked.reactionsRemove).mockClear();

      // And the thread now has 3 messages (one new)
      const repliesHandler2 = http.post(
        "https://slack.com/api/conversations.replies",
        () =>
          HttpResponse.json({
            ok: true,
            messages: [
              { user: "U111", text: "First message", ts: "1000000000.000000" },
              {
                user: userLink.slackUserId,
                text: "Second message",
                ts: "1000000001.000000",
              },
              {
                user: userLink.slackUserId,
                text: "Third message",
                ts: "1000000002.000000",
              },
            ],
          }),
      );
      server.use(repliesHandler2.handler);

      // When I send the second mention in the same thread
      const request2 = createSlackEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId,
        userId: userLink.slackUserId,
        text: `<@${installation.botUserId}> do more`,
        ts: "1000000002.000000",
        threadTs,
      });
      await POST(request2);
      await flushAfterCallbacks();

      // Then the agent should receive empty context (all prior messages already processed,
      // and "Third message" is the current mention excluded from context)
      expect(runAgentSpy).toHaveBeenCalledTimes(1);
      const secondCallContext = runAgentSpy.mock.calls[0]![0].threadContext;
      expect(secondCallContext).not.toContain("First message");
      expect(secondCallContext).not.toContain("Second message");
      expect(secondCallContext).not.toContain("Third message");
    });

    it("should not update lastProcessedMessageTs when agent run fails", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "my-helper",
      });

      // Use unique channel/thread IDs to avoid collisions with stale DB data
      const channelId = `C-dedup-fail-${Date.now()}`;
      const threadTs = "2000000000.000000";

      // Create an agent session so the FK constraint is satisfied
      const agentSession = await createTestAgentSession(
        userLink.vm0UserId,
        binding.composeId,
      );

      // And runAgentForSlack returns completed on first call, failed on second
      const runAgentSpy = vi.spyOn(runAgentModule, "runAgentForSlack");
      runAgentSpy.mockResolvedValueOnce({
        status: "completed",
        response: "Done!",
        sessionId: agentSession.id,
        runId: "test-run-id-1",
      });

      // Thread has 1 message
      const repliesHandler = http.post(
        "https://slack.com/api/conversations.replies",
        () =>
          HttpResponse.json({
            ok: true,
            messages: [
              {
                user: userLink.slackUserId,
                text: "First message",
                ts: "2000000000.000000",
              },
            ],
          }),
      );
      server.use(repliesHandler.handler);

      // First turn (succeeds) — establishes lastProcessedMessageTs
      const request1 = createSlackEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId,
        userId: userLink.slackUserId,
        text: `<@${installation.botUserId}> help`,
        ts: "2000000000.000000",
        threadTs,
      });
      await POST(request1);
      await flushAfterCallbacks();

      // Now runAgentForSlack fails on the second call
      runAgentSpy.mockResolvedValueOnce({
        status: "failed",
        response: "Error: something broke",
        sessionId: agentSession.id,
        runId: "test-run-id-2",
      });

      // Thread now has 2 messages
      const repliesHandler2 = http.post(
        "https://slack.com/api/conversations.replies",
        () =>
          HttpResponse.json({
            ok: true,
            messages: [
              {
                user: userLink.slackUserId,
                text: "First message",
                ts: "2000000000.000000",
              },
              {
                user: userLink.slackUserId,
                text: "Second message",
                ts: "2000000001.000000",
              },
            ],
          }),
      );
      server.use(repliesHandler2.handler);

      // Reset spy for second turn
      runAgentSpy.mockClear();
      runAgentSpy.mockResolvedValueOnce({
        status: "failed",
        response: "Error: something broke",
        sessionId: agentSession.id,
        runId: "test-run-id-2",
      });

      // Second turn (fails)
      const request2 = createSlackEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId,
        userId: userLink.slackUserId,
        text: `<@${installation.botUserId}> help again`,
        ts: "2000000001.000000",
        threadTs,
      });
      await POST(request2);
      await flushAfterCallbacks();

      // Reset for third turn
      runAgentSpy.mockClear();
      runAgentSpy.mockResolvedValueOnce({
        status: "completed",
        response: "Done!",
        sessionId: agentSession.id,
        runId: "test-run-id-3",
      });

      // Thread now has 3 messages
      const repliesHandler3 = http.post(
        "https://slack.com/api/conversations.replies",
        () =>
          HttpResponse.json({
            ok: true,
            messages: [
              {
                user: userLink.slackUserId,
                text: "First message",
                ts: "2000000000.000000",
              },
              {
                user: userLink.slackUserId,
                text: "Second message",
                ts: "2000000001.000000",
              },
              {
                user: userLink.slackUserId,
                text: "Third message",
                ts: "2000000002.000000",
              },
            ],
          }),
      );
      server.use(repliesHandler3.handler);

      // Third turn — should include "Second message" since the failed run didn't update the ts
      const request3 = createSlackEventRequest({
        teamId: installation.slackWorkspaceId,
        channelId,
        userId: userLink.slackUserId,
        text: `<@${installation.botUserId}> retry`,
        ts: "2000000002.000000",
        threadTs,
      });
      await POST(request3);
      await flushAfterCallbacks();

      expect(runAgentSpy).toHaveBeenCalledTimes(1);
      const thirdCallContext = runAgentSpy.mock.calls[0]![0].threadContext;
      // Second message should be resent since the failed run didn't update lastProcessedMessageTs
      expect(thirdCallContext).toContain("Second message");
      // Third message is the current mention, excluded from context (sent as prompt)
      expect(thirdCallContext).not.toContain("Third message");
      // First message was already processed in the successful first turn
      expect(thirdCallContext).not.toContain("First message");
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
      expect(slackHandlers.mocked.postMessage).not.toHaveBeenCalled();
    });
  });
});
