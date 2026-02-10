import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
  completeTestRun,
  createTestSchedule,
  linkRunToSchedule,
  findTestThreadSession,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";
import { POST as checkpointWebhook } from "../../checkpoints/route";
import {
  givenLinkedSlackUser,
  givenUserHasAgent,
} from "../../../../../../src/__tests__/slack/api-helpers";

// Mock Next.js after() to capture callbacks for synchronous execution in tests
const afterCallbacks: Array<() => Promise<unknown>> = [];
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return {
    ...original,
    after: (fn: () => Promise<unknown>) => {
      afterCallbacks.push(fn);
    },
  };
});

/** Execute all captured after() callbacks */
async function flushAfterCallbacks() {
  const callbacks = [...afterCallbacks];
  afterCallbacks.length = 0;
  await Promise.all(callbacks.map((fn) => fn()));
}

const context = testContext();

// Simulate real Slack behavior: when posting to a user ID (U...),
// Slack returns the actual DM channel ID (D...) in the response.
const MOCK_DM_CHANNEL_ID = "D-mock-dm-channel";

describe("POST /api/webhooks/agent/complete", () => {
  let user: UserContext;
  let testComposeId: string;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    context.setupMocks();
    afterCallbacks.length = 0;
    user = await context.setupUser();

    // Create compose for test runs
    const { composeId } = await createTestCompose(uniqueId("complete"));
    testComposeId = composeId;

    // Create a running run
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    testRunId = runId;

    // Generate JWT token for sandbox auth
    testToken = await createTestSandboxToken(user.userId, testRunId);

    // Reset auth mock for webhook tests (which use token auth, not Clerk)
    mockClerk({ userId: null });
  });

  describe("Authentication", () => {
    it("should reject complete without authentication", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(data.error.message).toBeDefined();
    });
  });

  describe("Validation", () => {
    it("should reject complete without runId", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            // runId: missing
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("runId");
    });

    it("should reject complete without exitCode", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            // exitCode: missing
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("exitCode");
    });
  });

  describe("Authorization", () => {
    it("should reject complete for non-existent run", async () => {
      const nonExistentRunId = randomUUID();
      const tokenForNonExistentRun = await createTestSandboxToken(
        user.userId,
        nonExistentRunId,
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenForNonExistentRun}`,
          },
          body: JSON.stringify({
            runId: nonExistentRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });

    it("should reject complete for run owned by different user", async () => {
      // Create another user with their own run
      await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        `other-compose-${Date.now()}`,
      );
      const { runId: otherRunId } = await createTestRun(
        otherComposeId,
        "Other user prompt",
      );

      // Switch back to original user and reset Clerk mock
      mockClerk({ userId: null });

      // Generate token for the original user but try to complete other user's run
      const tokenWithWrongUser = await createTestSandboxToken(
        user.userId,
        otherRunId, // other user's run
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenWithWrongUser}`,
          },
          body: JSON.stringify({
            runId: otherRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });
  });

  describe("Success", () => {
    it("should handle successful completion (exitCode=0)", async () => {
      // Create checkpoint first (required for successful completion)
      const checkpointRequest = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session",
            cliAgentSessionHistory: JSON.stringify({ type: "test" }),
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "v1",
            },
          }),
        },
      );
      const checkpointResponse = await checkpointWebhook(checkpointRequest);
      expect(checkpointResponse.status).toBe(200);

      // Now complete the run
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("completed");
    });

    it("should handle failed completion (exitCode≠0)", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
            error: "Agent crashed",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("failed");
    });

    it("should use default error message when exitCode≠0 and no error provided", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 127,
            // no error provided
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("failed");
    });
  });

  describe("Error Handling", () => {
    it("should return 404 when checkpoint not found for successful run", async () => {
      // Don't create checkpoint - complete should fail
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Checkpoint");
    });
  });

  describe("Idempotency", () => {
    it("should return success without processing for already completed run", async () => {
      // Complete the run first using the helper
      await completeTestRun(user.userId, testRunId);

      // Try to complete again
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("completed");
    });

    it("should return success without processing for already failed run", async () => {
      // Fail the run first
      const failRequest = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
            error: "Initial failure",
          }),
        },
      );

      const failResponse = await POST(failRequest);
      expect(failResponse.status).toBe(200);

      // Try to complete again with different exit code
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
            error: "Another error",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("failed");
    });
  });

  describe("Schedule Notification", () => {
    it("should send Slack DM when scheduled run completes successfully", async () => {
      // Given a linked Slack user with an agent and a schedule
      const { userLink } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "scheduled-agent",
      });

      mockClerk({ userId: userLink.vm0UserId });
      const schedule = await createTestSchedule(
        binding.composeId,
        uniqueId("sched"),
      );

      // And a run linked to the schedule
      const { runId } = await createTestRun(
        binding.composeId,
        "Scheduled task",
      );
      await linkRunToSchedule(runId, schedule.id);

      // Create checkpoint (required for successful completion)
      const token = await createTestSandboxToken(userLink.vm0UserId, runId);
      mockClerk({ userId: null });
      const checkpointRequest = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session",
            cliAgentSessionHistory: JSON.stringify({ type: "test" }),
          }),
        },
      );
      await checkpointWebhook(checkpointRequest);

      // Configure WebClient mock to return DM channel ID
      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.chat.postMessage.mockClear();
      mockClient.chat.postMessage.mockImplementation((args) => {
        const channel = String(args.channel ?? "");
        return Promise.resolve({
          ok: true,
          ts: `${Date.now()}.000000`,
          channel: channel.startsWith("U") ? MOCK_DM_CHANNEL_ID : channel,
        }) as never;
      });

      // When the run completes
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ runId, exitCode: 0 }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Then the after() callback should send a Slack DM
      await flushAfterCallbacks();

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const callArgs = mockClient.chat.postMessage.mock.calls[0]![0] as {
        channel: string;
        blocks: Array<{ type: string; text?: { text: string } }>;
      };
      // DM is sent to the Slack user ID
      expect(callArgs.channel).toBe(userLink.slackUserId);
      // Message should contain the agent name and success indicator
      const sectionTexts = callArgs.blocks
        .filter((b) => b.type === "section")
        .map((b) => b.text?.text ?? "");
      expect(sectionTexts.some((t) => t.includes("completed"))).toBe(true);
      expect(sectionTexts.some((t) => t.includes("scheduled-agent"))).toBe(
        true,
      );

      // Thread session should be saved with the real DM channel ID (D...),
      // not the Slack user ID (U...) that was used to send the message
      const threadSession = await findTestThreadSession(MOCK_DM_CHANNEL_ID);
      expect(threadSession).not.toBeNull();
      expect(threadSession!.slackBindingId).toBeNull();
      expect(threadSession!.agentSessionId).toBeDefined();
    });

    it("should send error notification when scheduled run fails", async () => {
      // Given a linked Slack user with an agent and a schedule
      const { userLink } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "my-agent",
      });

      mockClerk({ userId: userLink.vm0UserId });
      const schedule = await createTestSchedule(
        binding.composeId,
        uniqueId("sched"),
      );

      // And a run linked to the schedule
      const { runId } = await createTestRun(
        binding.composeId,
        "Scheduled task",
      );
      await linkRunToSchedule(runId, schedule.id);
      mockClerk({ userId: null });

      const token = await createTestSandboxToken(userLink.vm0UserId, runId);

      // Configure WebClient mock
      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.chat.postMessage.mockClear();

      // When the run fails
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId,
            exitCode: 1,
            error: "Agent crashed",
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Then the after() callback should send an error notification
      await flushAfterCallbacks();

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const callArgs = mockClient.chat.postMessage.mock.calls[0]![0] as {
        channel: string;
        blocks: Array<{ type: string; text?: { text: string } }>;
      };
      expect(callArgs.channel).toBe(userLink.slackUserId);
      // Message should contain error info
      const sectionTexts = callArgs.blocks
        .filter((b) => b.type === "section")
        .map((b) => b.text?.text ?? "");
      expect(sectionTexts.some((t) => t.includes("failed"))).toBe(true);
      expect(sectionTexts.some((t) => t.includes("Agent crashed"))).toBe(true);
    });

    it("should not send notification when user has no Slack link", async () => {
      // Given a schedule for the existing test compose (user has NO Slack link)
      mockClerk({ userId: user.userId });
      const schedule = await createTestSchedule(
        testComposeId,
        uniqueId("sched"),
      );
      mockClerk({ userId: null });

      // Link the existing test run to the schedule
      await linkRunToSchedule(testRunId, schedule.id);

      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.chat.postMessage.mockClear();

      // When the run fails
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
            error: "Agent crashed",
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Then no Slack DM should be sent (user has no Slack link)
      await flushAfterCallbacks();

      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it("should not send notification for non-scheduled runs", async () => {
      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.chat.postMessage.mockClear();

      // When a non-scheduled run completes (testRunId has no scheduleId)
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
            error: "Some error",
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Then no after() callback should be registered (no scheduleId)
      expect(afterCallbacks).toHaveLength(0);
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });
  });
});
