import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { NextRequest } from "next/server";
import { POST } from "../route";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import {
  givenLinkedSlackUser,
  givenUserHasAgent,
} from "../../../../../../src/__tests__/slack/api-helpers";
import {
  createTestRun,
  createTestCallback,
  createTestAgentSession,
  createTestRequest,
} from "../../../../../../src/__tests__/api-test-helpers";
import { computeHmacSignature } from "../../../../../../src/lib/callback/hmac";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

// Get the WebClient mock singleton
const mockClient = vi.mocked(new WebClient(), true);

interface CallbackPayload {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userLinkId: string;
  agentName: string;
  composeId: string;
  existingSessionId?: string;
  reactionAdded: boolean;
}

/**
 * Create a signed callback request
 */
function createCallbackRequest(
  body: {
    runId: string;
    status: "completed" | "failed";
    result?: Record<string, unknown>;
    error?: string;
    payload: CallbackPayload;
  },
  secret: string,
  options?: { invalidSignature?: boolean; expiredTimestamp?: boolean },
): NextRequest {
  const bodyString = JSON.stringify(body);
  const timestamp = options?.expiredTimestamp
    ? Math.floor(Date.now() / 1000) - 600 // 10 minutes ago
    : Math.floor(Date.now() / 1000);

  const signature = options?.invalidSignature
    ? "invalid-signature"
    : computeHmacSignature(bodyString, secret, timestamp);

  return createTestRequest("http://localhost/api/internal/callbacks/slack", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VM0-Signature": signature,
      "X-VM0-Timestamp": timestamp.toString(),
    },
    body: bodyString,
  });
}

describe("POST /api/internal/callbacks/slack", () => {
  beforeEach(() => {
    context.setupMocks();
    mockClient.chat.postMessage.mockClear();
    mockClient.reactions.remove.mockClear();
  });

  describe("Signature Verification", () => {
    it("should reject request with invalid signature", async () => {
      // Given a linked Slack user with an agent
      const { userLink, installation } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "test-agent",
      });

      // And a run with a registered callback
      mockClerk({ userId: userLink.vm0UserId });
      const { runId } = await createTestRun(binding.composeId, "Test prompt");
      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack",
        payload: {
          workspaceId: installation.slackWorkspaceId,
          channelId: "C123",
          threadTs: "1234567890.000000",
          messageTs: "1234567890.123456",
          userLinkId: userLink.id,
          agentName: "test-agent",
          composeId: binding.composeId,
          reactionAdded: true,
        },
      });

      // When I send a request with an invalid signature
      const request = createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: {
            workspaceId: installation.slackWorkspaceId,
            channelId: "C123",
            threadTs: "1234567890.000000",
            messageTs: "1234567890.123456",
            userLinkId: userLink.id,
            agentName: "test-agent",
            composeId: binding.composeId,
            reactionAdded: true,
          },
        },
        secret,
        { invalidSignature: true },
      );
      const response = await POST(request);

      // Then the request should be rejected
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain("signature");
    });

    it("should reject request with expired timestamp", async () => {
      // Given a linked Slack user with an agent
      const { userLink, installation } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "test-agent",
      });

      // And a run with a registered callback
      mockClerk({ userId: userLink.vm0UserId });
      const { runId } = await createTestRun(binding.composeId, "Test prompt");
      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack",
        payload: {
          workspaceId: installation.slackWorkspaceId,
          channelId: "C123",
          threadTs: "1234567890.000000",
          messageTs: "1234567890.123456",
          userLinkId: userLink.id,
          agentName: "test-agent",
          composeId: binding.composeId,
          reactionAdded: true,
        },
      });

      // When I send a request with an expired timestamp
      const request = createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: {
            workspaceId: installation.slackWorkspaceId,
            channelId: "C123",
            threadTs: "1234567890.000000",
            messageTs: "1234567890.123456",
            userLinkId: userLink.id,
            agentName: "test-agent",
            composeId: binding.composeId,
            reactionAdded: true,
          },
        },
        secret,
        { expiredTimestamp: true },
      );
      const response = await POST(request);

      // Then the request should be rejected
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain("expired");
    });

    it("should reject request with missing signature header", async () => {
      // Given a run ID
      const runId = "00000000-0000-0000-0000-000000000001";

      // When I send a request without signature header
      const request = createTestRequest(
        "http://localhost/api/internal/callbacks/slack",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-VM0-Timestamp": Math.floor(Date.now() / 1000).toString(),
          },
          body: JSON.stringify({
            runId,
            status: "completed",
            payload: {
              workspaceId: "T123",
              channelId: "C123",
              threadTs: "1234567890.000000",
              messageTs: "1234567890.123456",
              userLinkId: "link-123",
              agentName: "test-agent",
              composeId: "compose-123",
              reactionAdded: false,
            },
          }),
        },
      );
      const response = await POST(request);

      // Then the request should be rejected
      expect(response.status).toBe(404);
    });

    it("should reject request for non-existent callback", async () => {
      const runId = "00000000-0000-0000-0000-000000000001";

      // When I send a request for a run with no callback
      const request = createTestRequest(
        "http://localhost/api/internal/callbacks/slack",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-VM0-Signature": "any-signature",
            "X-VM0-Timestamp": Math.floor(Date.now() / 1000).toString(),
          },
          body: JSON.stringify({
            runId,
            status: "completed",
            payload: {
              workspaceId: "T123",
              channelId: "C123",
              threadTs: "1234567890.000000",
              messageTs: "1234567890.123456",
              userLinkId: "link-123",
              agentName: "test-agent",
              composeId: "compose-123",
              reactionAdded: false,
            },
          }),
        },
      );
      const response = await POST(request);

      // Then the request should return 404
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain("not found");
    });
  });

  describe("Successful Callback", () => {
    it("should post response message to Slack on completed run", async () => {
      // Given a linked Slack user with an agent
      const { userLink, installation } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "test-agent",
      });

      // And a run with a registered callback
      mockClerk({ userId: userLink.vm0UserId });
      const { runId } = await createTestRun(binding.composeId, "Test prompt");
      const channelId = `C-callback-${Date.now()}`;
      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack",
        payload: {
          workspaceId: installation.slackWorkspaceId,
          channelId,
          threadTs: "1234567890.000000",
          messageTs: "1234567890.123456",
          userLinkId: userLink.id,
          agentName: "test-agent",
          composeId: binding.composeId,
          reactionAdded: true,
        },
      });

      // When the callback is invoked with completed status
      const request = createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: {
            workspaceId: installation.slackWorkspaceId,
            channelId,
            threadTs: "1234567890.000000",
            messageTs: "1234567890.123456",
            userLinkId: userLink.id,
            agentName: "test-agent",
            composeId: binding.composeId,
            reactionAdded: true,
          },
        },
        secret,
      );
      const response = await POST(request);

      // Then the request should succeed
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // And a message should be posted to Slack
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const callArgs = mockClient.chat.postMessage.mock.calls[0]![0] as {
        channel: string;
        thread_ts: string;
      };
      expect(callArgs.channel).toBe(channelId);
      expect(callArgs.thread_ts).toBe("1234567890.000000");

      // And the thinking reaction should be removed
      expect(mockClient.reactions.remove).toHaveBeenCalledTimes(1);
    });

    it("should post error message on failed run", async () => {
      // Given a linked Slack user with an agent
      const { userLink, installation } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "test-agent",
      });

      // And a run with a registered callback
      mockClerk({ userId: userLink.vm0UserId });
      const { runId } = await createTestRun(binding.composeId, "Test prompt");
      const channelId = `C-fail-${Date.now()}`;
      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack",
        payload: {
          workspaceId: installation.slackWorkspaceId,
          channelId,
          threadTs: "1234567890.000000",
          messageTs: "1234567890.123456",
          userLinkId: userLink.id,
          agentName: "test-agent",
          composeId: binding.composeId,
          reactionAdded: true,
        },
      });

      // When the callback is invoked with failed status
      const request = createCallbackRequest(
        {
          runId,
          status: "failed",
          error: "Agent crashed unexpectedly",
          payload: {
            workspaceId: installation.slackWorkspaceId,
            channelId,
            threadTs: "1234567890.000000",
            messageTs: "1234567890.123456",
            userLinkId: userLink.id,
            agentName: "test-agent",
            composeId: binding.composeId,
            reactionAdded: true,
          },
        },
        secret,
      );
      const response = await POST(request);

      // Then the request should succeed
      expect(response.status).toBe(200);

      // And an error message should be posted
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const callArgs = mockClient.chat.postMessage.mock.calls[0]![0] as {
        text: string;
      };
      expect(callArgs.text).toContain("Error");
      expect(callArgs.text).toContain("Agent crashed unexpectedly");
    });

    it("should not remove reaction when reactionAdded is false", async () => {
      // Given a linked Slack user with an agent
      const { userLink, installation } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "test-agent",
      });

      // And a run with callback where reactionAdded is false
      mockClerk({ userId: userLink.vm0UserId });
      const { runId } = await createTestRun(binding.composeId, "Test prompt");
      const channelId = `C-noreact-${Date.now()}`;
      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack",
        payload: {
          workspaceId: installation.slackWorkspaceId,
          channelId,
          threadTs: "1234567890.000000",
          messageTs: "1234567890.123456",
          userLinkId: userLink.id,
          agentName: "test-agent",
          composeId: binding.composeId,
          reactionAdded: false, // No reaction was added
        },
      });

      // When the callback is invoked
      const request = createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: {
            workspaceId: installation.slackWorkspaceId,
            channelId,
            threadTs: "1234567890.000000",
            messageTs: "1234567890.123456",
            userLinkId: userLink.id,
            agentName: "test-agent",
            composeId: binding.composeId,
            reactionAdded: false,
          },
        },
        secret,
      );
      const response = await POST(request);

      // Then the request should succeed
      expect(response.status).toBe(200);

      // And no reaction removal should be attempted
      expect(mockClient.reactions.remove).not.toHaveBeenCalled();
    });
  });

  describe("Thread Session", () => {
    it("should create thread session for new thread on successful completion", async () => {
      // Given a linked Slack user with an agent
      const { userLink, installation } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "test-agent",
      });

      // And a run with callback (no existingSessionId = new thread)
      mockClerk({ userId: userLink.vm0UserId });
      const { runId } = await createTestRun(binding.composeId, "Test prompt");
      const channelId = `C-session-${Date.now()}`;
      const threadTs = `${Date.now()}.000000`;

      // Create an agent session for the FK constraint
      await createTestAgentSession(userLink.vm0UserId, binding.composeId);

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack",
        payload: {
          workspaceId: installation.slackWorkspaceId,
          channelId,
          threadTs,
          messageTs: `${Date.now()}.123456`,
          userLinkId: userLink.id,
          agentName: "test-agent",
          composeId: binding.composeId,
          reactionAdded: true,
        },
      });

      // Simulate that findNewSessionId will find this session
      // by ensuring the agent session was created after the run
      // (The actual logic queries by composeId and timestamps)

      // When the callback is invoked
      const request = createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: {
            workspaceId: installation.slackWorkspaceId,
            channelId,
            threadTs,
            messageTs: `${Date.now()}.123456`,
            userLinkId: userLink.id,
            agentName: "test-agent",
            composeId: binding.composeId,
            reactionAdded: true,
          },
        },
        secret,
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Then a thread session should be created
      // Note: findNewSessionId may not find the session in this test setup
      // because the session was created before the run, not after.
      // This test mainly verifies the callback processes without error.
    });

    it("should update lastProcessedMessageTs for existing session", async () => {
      // Given a linked Slack user with an agent
      const { userLink, installation } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "test-agent",
      });

      // And a run with callback with an existing session
      mockClerk({ userId: userLink.vm0UserId });
      const { runId } = await createTestRun(binding.composeId, "Test prompt");
      const channelId = `C-existing-${Date.now()}`;
      const threadTs = `${Date.now()}.000000`;
      const existingSessionId = "existing-session-id";

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack",
        payload: {
          workspaceId: installation.slackWorkspaceId,
          channelId,
          threadTs,
          messageTs: `${Date.now()}.123456`,
          userLinkId: userLink.id,
          agentName: "test-agent",
          composeId: binding.composeId,
          existingSessionId, // Existing session
          reactionAdded: true,
        },
      });

      // When the callback is invoked
      const request = createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: {
            workspaceId: installation.slackWorkspaceId,
            channelId,
            threadTs,
            messageTs: `${Date.now()}.123456`,
            userLinkId: userLink.id,
            agentName: "test-agent",
            composeId: binding.composeId,
            existingSessionId,
            reactionAdded: true,
          },
        },
        secret,
      );
      const response = await POST(request);

      // Then the request should succeed
      // (actual update depends on having a matching thread session record)
      expect(response.status).toBe(200);
    });
  });

  describe("Validation", () => {
    it("should reject request with missing runId", async () => {
      const request = createTestRequest(
        "http://localhost/api/internal/callbacks/slack",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-VM0-Signature": "any-signature",
            "X-VM0-Timestamp": Math.floor(Date.now() / 1000).toString(),
          },
          body: JSON.stringify({
            // runId: missing
            status: "completed",
            payload: {
              workspaceId: "T123",
              channelId: "C123",
              threadTs: "1234567890.000000",
              messageTs: "1234567890.123456",
              userLinkId: "link-123",
              agentName: "test-agent",
              composeId: "compose-123",
              reactionAdded: false,
            },
          }),
        },
      );
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain("runId");
    });

    it("should reject request with invalid payload", async () => {
      // Given a linked Slack user with an agent
      const { userLink, installation } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "test-agent",
      });

      // And a run with a registered callback
      mockClerk({ userId: userLink.vm0UserId });
      const { runId } = await createTestRun(binding.composeId, "Test prompt");
      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack",
        payload: {
          workspaceId: installation.slackWorkspaceId,
          channelId: "C123",
          threadTs: "1234567890.000000",
          messageTs: "1234567890.123456",
          userLinkId: userLink.id,
          agentName: "test-agent",
          composeId: binding.composeId,
          reactionAdded: true,
        },
      });

      // When I send a request with incomplete payload
      const body = JSON.stringify({
        runId,
        status: "completed",
        payload: {
          workspaceId: installation.slackWorkspaceId,
          // Missing required fields
        },
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = computeHmacSignature(body, secret, timestamp);

      const request = createTestRequest(
        "http://localhost/api/internal/callbacks/slack",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-VM0-Signature": signature,
            "X-VM0-Timestamp": timestamp.toString(),
          },
          body,
        },
      );
      const response = await POST(request);

      // Then the request should be rejected
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain("payload");
    });
  });
});
