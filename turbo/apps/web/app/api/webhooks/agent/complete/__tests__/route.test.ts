import { describe, it, expect, beforeEach, vi } from "vitest";
import { Resend } from "resend";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
  completeTestRun,
  createTestSchedule,
  linkRunToSchedule,
  createTestAgentSession,
  createTestEmailThreadSession,
  createTestCallback,
  findTestCallbacksByRunId,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";
import { POST as checkpointWebhook } from "../../checkpoints/route";
import { generateReplyToken } from "../../../../../../src/lib/email/handlers/shared";

const context = testContext();

describe("POST /api/webhooks/agent/complete", () => {
  let user: UserContext;
  let testComposeId: string;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    context.setupMocks();
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

  describe("Callback Dispatch", () => {
    it("should dispatch registered callbacks on run completion", async () => {
      // Register a callback for this run
      await createTestCallback({
        runId: testRunId,
        url: "http://localhost/api/internal/callbacks/test",
        payload: { testKey: "testValue" },
      });

      // When the run fails (simpler, no checkpoint needed)
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

      // Flush the after() callback (dispatchCallbacks)
      await context.mocks.flushAfter();

      // Verify the callback was attempted (status should be updated)
      const callbacks = await findTestCallbacksByRunId(testRunId);
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0]!.attempts).toBe(1);
    });

    it("should register only one after() callback for dispatch", async () => {
      // When a non-scheduled run completes (testRunId has no callbacks)
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

      // Only one after() callback: dispatchCallbacks
      expect(globalThis.nextAfterCallbacks).toHaveLength(1);
      await context.mocks.flushAfter();
    });

    it("should not send notifications for non-scheduled runs without callbacks", async () => {
      const mockResend = vi.mocked(new Resend(""), true);
      mockResend.emails.send.mockClear();

      // When a normal run completes (no callbacks registered)
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

      await context.mocks.flushAfter();

      // No email should be sent (no callbacks registered)
      expect(mockResend.emails.send).not.toHaveBeenCalled();
    });

    it("should dispatch email reply callback when registered", async () => {
      // Set up an email reply callback
      const emailUser = await context.setupUser({ prefix: "email-cb" });
      mockClerk({ userId: emailUser.userId });
      const { composeId } = await createTestCompose(uniqueId("reply-agent"));
      const agentSession = await createTestAgentSession(
        emailUser.userId,
        composeId,
      );
      const replyToken = generateReplyToken(agentSession.id);

      const emailSession = await createTestEmailThreadSession({
        userId: emailUser.userId,
        composeId,
        agentSessionId: agentSession.id,
        replyToToken: replyToken,
        lastEmailMessageId: "<original-msg-id@vm7.bot>",
      });

      const { runId } = await createTestRun(composeId, "Email reply task");

      // Register a callback (as the inbound-reply handler now does)
      await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/reply",
        payload: {
          emailThreadSessionId: emailSession.id,
          inboundEmailId: "inbound-email-456",
        },
      });

      const token = await createTestSandboxToken(emailUser.userId, runId);
      mockClerk({ userId: null });

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

      await context.mocks.flushAfter();

      // Verify the callback was dispatched (attempted)
      const callbacks = await findTestCallbacksByRunId(runId);
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0]!.attempts).toBe(1);
    });

    it("should dispatch schedule callbacks when registered", async () => {
      // Use a separate user for concurrency
      const schedUser = await context.setupUser({ prefix: "sched-cb" });
      mockClerk({ userId: schedUser.userId });
      const { composeId } = await createTestCompose(uniqueId("sched-agent"));
      const schedule = await createTestSchedule(composeId, uniqueId("sched"));
      const { runId } = await createTestRun(composeId, "Scheduled task");
      await linkRunToSchedule(runId, schedule.id);

      // Register callbacks (as executeSchedule now does)
      await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/schedule",
        payload: {
          scheduleId: schedule.id,
          composeId,
          composeName: "sched-agent",
          userId: schedUser.userId,
        },
      });
      await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack/schedule",
        payload: {
          scheduleId: schedule.id,
          composeId,
          composeName: "sched-agent",
          userId: schedUser.userId,
        },
      });

      const token = await createTestSandboxToken(schedUser.userId, runId);
      mockClerk({ userId: null });

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

      await context.mocks.flushAfter();

      // Verify both callbacks were dispatched (attempted)
      const callbacks = await findTestCallbacksByRunId(runId);
      expect(callbacks).toHaveLength(2);
      expect(callbacks.every((c) => c.attempts === 1)).toBe(true);
    });
  });
});
