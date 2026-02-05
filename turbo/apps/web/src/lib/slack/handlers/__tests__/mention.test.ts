import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { testContext } from "../../../../__tests__/test-helpers";
import { server } from "../../../../mocks/server";
import { reloadEnv } from "../../../../env";
import {
  givenLinkedSlackUser,
  givenSlackWorkspaceInstalled,
  givenUserHasAgent,
  givenUserHasMultipleAgents,
} from "../../__tests__/helpers";
import { handleAppMention } from "../mention";
import * as runAgentModule from "../run-agent";

// Mock external dependencies
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

// Track Slack API calls via MSW
let slackApiCalls: Array<{ method: string; body: unknown }> = [];

// Store original env value for cleanup
let originalSlackRedirectBaseUrl: string | undefined;

function setupSlackMswHandlers() {
  slackApiCalls = [];

  server.use(
    http.post("https://slack.com/api/chat.postMessage", async ({ request }) => {
      const body = await request.formData();
      const data = Object.fromEntries(body.entries());
      slackApiCalls.push({ method: "chat.postMessage", body: data });
      return HttpResponse.json({
        ok: true,
        ts: `${Date.now()}.000000`,
        channel: data.channel,
      });
    }),
    http.post(
      "https://slack.com/api/chat.postEphemeral",
      async ({ request }) => {
        const body = await request.formData();
        const data = Object.fromEntries(body.entries());
        slackApiCalls.push({ method: "chat.postEphemeral", body: data });
        return HttpResponse.json({
          ok: true,
          message_ts: `${Date.now()}.000000`,
        });
      },
    ),
    http.post("https://slack.com/api/chat.update", async ({ request }) => {
      const body = await request.formData();
      const data = Object.fromEntries(body.entries());
      slackApiCalls.push({ method: "chat.update", body: data });
      return HttpResponse.json({
        ok: true,
        ts: data.ts,
        channel: data.channel,
      });
    }),
    http.post("https://slack.com/api/reactions.add", async ({ request }) => {
      const body = await request.formData();
      const data = Object.fromEntries(body.entries());
      slackApiCalls.push({ method: "reactions.add", body: data });
      return HttpResponse.json({ ok: true });
    }),
    http.post("https://slack.com/api/reactions.remove", async ({ request }) => {
      const body = await request.formData();
      const data = Object.fromEntries(body.entries());
      slackApiCalls.push({ method: "reactions.remove", body: data });
      return HttpResponse.json({ ok: true });
    }),
    http.post(
      "https://slack.com/api/conversations.replies",
      async ({ request }) => {
        const body = await request.formData();
        const data = Object.fromEntries(body.entries());
        slackApiCalls.push({ method: "conversations.replies", body: data });
        return HttpResponse.json({ ok: true, messages: [] });
      },
    ),
    http.post(
      "https://slack.com/api/conversations.history",
      async ({ request }) => {
        const body = await request.formData();
        const data = Object.fromEntries(body.entries());
        slackApiCalls.push({ method: "conversations.history", body: data });
        return HttpResponse.json({ ok: true, messages: [] });
      },
    ),
  );
}

describe("Feature: App Mention Handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    context.setupMocks();
    setupSlackMswHandlers();
    // Set required env var for Slack redirect URL and reload env cache
    originalSlackRedirectBaseUrl = process.env.SLACK_REDIRECT_BASE_URL;
    process.env.SLACK_REDIRECT_BASE_URL = "https://test.example.com";
    reloadEnv();
  });

  afterEach(() => {
    server.resetHandlers();
    vi.restoreAllMocks();
    // Restore original env value and reload env cache
    if (originalSlackRedirectBaseUrl === undefined) {
      delete process.env.SLACK_REDIRECT_BASE_URL;
    } else {
      process.env.SLACK_REDIRECT_BASE_URL = originalSlackRedirectBaseUrl;
    }
    reloadEnv();
  });

  describe("Scenario: Mention bot as unlinked user", () => {
    it("should post ephemeral login prompt when user is not linked", async () => {
      // Given I am a Slack user without a linked account
      const { installation } = await givenSlackWorkspaceInstalled();

      // When I @mention the VM0 bot
      await handleAppMention({
        workspaceId: installation.slackWorkspaceId,
        channelId: "C123",
        userId: "U-unlinked-user",
        messageText: "<@BOT123> help me",
        messageTs: "1234567890.123456",
      });

      // Then I should receive an ephemeral login prompt (only visible to me)
      const ephemeralCalls = slackApiCalls.filter(
        (c) => c.method === "chat.postEphemeral",
      );
      expect(ephemeralCalls).toHaveLength(1);

      const call = ephemeralCalls[0]!;
      expect(call.body).toMatchObject({
        channel: "C123",
        user: "U-unlinked-user",
      });

      // Check that blocks contain login URL with channel parameter
      const blocks = JSON.parse(
        (call.body as { blocks?: string }).blocks ?? "[]",
      );
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
      await handleAppMention({
        workspaceId: installation.slackWorkspaceId,
        channelId: "C123",
        userId: "U-unlinked-user",
        messageText: "<@BOT123> help me",
        messageTs: "1234567890.123456",
        threadTs: "1234567890.000000", // This is a thread reply
      });

      // Then the ephemeral message should NOT include thread_ts
      // (Slack ephemeral messages with thread_ts don't display correctly)
      const ephemeralCalls = slackApiCalls.filter(
        (c) => c.method === "chat.postEphemeral",
      );
      expect(ephemeralCalls).toHaveLength(1);

      const call = ephemeralCalls[0]!;
      const body = call.body as { thread_ts?: string };
      expect(body.thread_ts).toBeUndefined();
    });
  });

  describe("Scenario: Mention bot with no agents", () => {
    it("should prompt user to add an agent", async () => {
      // Given I am a linked Slack user with no agents
      const { userLink, installation } = await givenLinkedSlackUser();

      // When I @mention the VM0 bot
      await handleAppMention({
        workspaceId: installation.slackWorkspaceId,
        channelId: "C123",
        userId: userLink.slackUserId,
        messageText: `<@${installation.botUserId}> help me`,
        messageTs: "1234567890.123456",
      });

      // Then I should receive a message prompting to add an agent
      const postCalls = slackApiCalls.filter(
        (c) => c.method === "chat.postMessage",
      );
      expect(postCalls).toHaveLength(1);

      const call = postCalls[0]!;
      const text = (call.body as { text?: string }).text ?? "";
      expect(text).toContain("don't have any agents");
      expect(text).toContain("/vm0 agent add");
    });
  });

  describe("Scenario: Mention bot with single agent", () => {
    it("should execute agent and post response", async () => {
      // Given I am a linked Slack user with one agent
      const { userLink, installation } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink.id, {
        agentName: "my-helper",
        description: "A helpful assistant",
      });

      // Mock runAgentForSlack at the handler boundary.
      // This is intentional: runAgentForSlack involves complex async operations
      // (E2B sandbox, Axiom queries, 30-min polling) that should be tested separately.
      // This test focuses on handleAppMention's routing and Slack API interactions.
      const mockRunAgent = vi
        .spyOn(runAgentModule, "runAgentForSlack")
        .mockResolvedValue({
          response: "Here is my helpful response!",
          sessionId: undefined, // Avoid FK constraint on agent_sessions
          runId: "test-run-id",
        });

      // When I @mention the VM0 bot
      await handleAppMention({
        workspaceId: installation.slackWorkspaceId,
        channelId: "C123",
        userId: userLink.slackUserId,
        messageText: `<@${installation.botUserId}> help me with this code`,
        messageTs: "1234567890.123456",
      });

      // Then:
      // 1. Thinking reaction should be added
      const reactionAddCalls = slackApiCalls.filter(
        (c) => c.method === "reactions.add",
      );
      expect(reactionAddCalls).toHaveLength(1);
      expect((reactionAddCalls[0]!.body as { name?: string }).name).toBe(
        "thought_balloon",
      );

      // 2. Thinking message should be posted
      const postCalls = slackApiCalls.filter(
        (c) => c.method === "chat.postMessage",
      );
      expect(postCalls).toHaveLength(1);

      // 3. Agent should be executed with correct prompt
      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "help me with this code",
          binding: expect.objectContaining({
            id: binding.id,
          }),
        }),
      );

      // 4. Response message should be posted with the agent's response
      // Note: The new flow posts response directly without intermediate "Thinking..." message
      expect(postCalls).toHaveLength(1);
      const responseBody = postCalls[0]!.body as {
        text?: string;
        blocks?: string;
      };
      expect(responseBody.text).toBe("Here is my helpful response!");

      // Parse blocks from JSON string (Slack form data sends blocks as JSON string)
      const blocks = JSON.parse(responseBody.blocks ?? "[]") as Array<{
        type: string;
        elements?: Array<{ text?: string }>;
      }>;

      // 5. Response should include agent name in context block
      const contextBlocks = blocks.filter((b) => b.type === "context");
      expect(contextBlocks.length).toBeGreaterThanOrEqual(1);
      // First context block should have agent name
      const agentContext = contextBlocks[0]!.elements?.[0]?.text;
      expect(agentContext).toContain("my-helper");

      // 6. Response should include logs URL in last context block
      const logsContext =
        contextBlocks[contextBlocks.length - 1]!.elements?.[0]?.text;
      expect(logsContext).toContain("/logs/test-run-id");

      // 7. Thinking reaction should be removed
      const reactionRemoveCalls = slackApiCalls.filter(
        (c) => c.method === "reactions.remove",
      );
      expect(reactionRemoveCalls).toHaveLength(1);
    });
  });

  describe("Scenario: Mention bot with multiple agents (explicit selection)", () => {
    it("should use explicitly selected agent", async () => {
      // Given I have agents "coder" and "reviewer"
      const { userLink, installation } = await givenLinkedSlackUser();
      const agents = await givenUserHasMultipleAgents(userLink.id, [
        { name: "coder", description: "Writes code" },
        { name: "reviewer", description: "Reviews code" },
      ]);

      // Mock runAgentForSlack at handler boundary (see single agent test for rationale)
      const mockRunAgent = vi
        .spyOn(runAgentModule, "runAgentForSlack")
        .mockResolvedValue({
          response: "Code fixed!",
          sessionId: undefined,
          runId: "test-run-id",
        });

      // When I say "use coder fix this bug"
      await handleAppMention({
        workspaceId: installation.slackWorkspaceId,
        channelId: "C123",
        userId: userLink.slackUserId,
        messageText: `<@${installation.botUserId}> use coder fix this bug`,
        messageTs: "1234567890.123456",
      });

      // Then "coder" should be selected
      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          binding: expect.objectContaining({
            id: agents[0]?.binding.id,
          }),
          // And prompt should be "fix this bug"
          prompt: "fix this bug",
        }),
      );
    });
  });

  describe("Scenario: Mention bot with multiple agents (ambiguous)", () => {
    it("should show list of available agents when routing is ambiguous", async () => {
      // Given I have similar agents
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasMultipleAgents(userLink.id, [
        { name: "agent-a", description: "A friendly helper" },
        { name: "agent-b", description: "Another friendly helper" },
      ]);

      // When I say "hello" (ambiguous - could be for either agent)
      await handleAppMention({
        workspaceId: installation.slackWorkspaceId,
        channelId: "C123",
        userId: userLink.slackUserId,
        messageText: `<@${installation.botUserId}> hello`,
        messageTs: "1234567890.123456",
      });

      // Then I should see list of available agents
      // Note: The new flow posts error message directly via postMessage
      const postCalls = slackApiCalls.filter(
        (c) => c.method === "chat.postMessage",
      );
      expect(postCalls).toHaveLength(1);
      const text = (postCalls[0]!.body as { text?: string }).text ?? "";
      expect(text).toContain("couldn't determine which agent");
      expect(text).toContain("agent-a");
      expect(text).toContain("agent-b");
    });
  });

  describe("Scenario: Explicit selection of non-existent agent", () => {
    it("should show error when selected agent does not exist", async () => {
      // Given I have agent "coder"
      const { userLink, installation } = await givenLinkedSlackUser();
      await givenUserHasAgent(userLink.id, {
        agentName: "coder",
        description: "Writes code",
      });

      // When I say "use writer help me"
      await handleAppMention({
        workspaceId: installation.slackWorkspaceId,
        channelId: "C123",
        userId: userLink.slackUserId,
        messageText: `<@${installation.botUserId}> use writer help me`,
        messageTs: "1234567890.123456",
      });

      // Then I should see error that "writer" not found
      // Note: The new flow posts error message directly via postMessage
      const postCalls = slackApiCalls.filter(
        (c) => c.method === "chat.postMessage",
      );
      expect(postCalls).toHaveLength(1);
      const text = (postCalls[0]!.body as { text?: string }).text ?? "";
      expect(text).toContain('"writer" not found');
      // And I should see list of available agents
      expect(text).toContain("coder");
    });
  });

  describe("Scenario: Installation not found", () => {
    it("should handle gracefully when workspace is not installed", async () => {
      // Given workspace is not installed (no installation record)
      // When event is received for unknown workspace
      await handleAppMention({
        workspaceId: "T-unknown-workspace",
        channelId: "C123",
        userId: "U123",
        messageText: "<@BOT123> help me",
        messageTs: "1234567890.123456",
      });

      // Then no messages should be sent (silent failure)
      const postCalls = slackApiCalls.filter(
        (c) => c.method === "chat.postMessage",
      );
      expect(postCalls).toHaveLength(0);
    });
  });
});
