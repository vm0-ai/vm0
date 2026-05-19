import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { Resend } from "resend";
import { server } from "../../../../../../src/mocks/server";
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
  createTestCallback,
  findTestCallbacksByRunId,
  findTestRunRecord,
  findTestQueueEntry,
  enqueueTestRun,
  addTestRunToThread,
  insertTestChatThread,
  insertTestUsagePricing,
  insertTestUsageEvent,
  findTestUsageEvent,
  setOrgCredits,
  getOrgCredits,
} from "../../../../../../src/__tests__/api-test-helpers";
import { createTestEmailThreadSession } from "../../../../../../src/__tests__/db-test-seeders/email";
import { generateReplyToken } from "../../../../../../src/lib/zero/email/handlers/shared";
import { createTestZeroAgent } from "../../../../../../src/__tests__/db-test-seeders/agents";
import { reloadEnv } from "../../../../../../src/env";
import {
  nextAfterCallbacks,
  resetNextAfterHooks,
} from "../../../../../../src/__tests__/next-after-hooks";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";
import { POST as checkpointWebhook } from "../../checkpoints/route";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { transitionRunStatus } from "../../../../../../src/lib/infra/run/run-status";

const context = testContext();

describe("POST /api/webhooks/agent/complete", () => {
  let user: UserContext;
  let testComposeId: string;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    vi.stubEnv("AXIOM_TOKEN_SESSIONS", "test-sessions-token");
    reloadEnv();
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

  async function createCheckpoint(runId = testRunId, token = testToken) {
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
          cliAgentSessionHistoryHash:
            "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
          artifactSnapshots: [
            {
              name: "test-artifact",
              version: "v1",
              mountPath: "/home/user/workspace",
            },
          ],
        }),
      },
    );
    const checkpointResponse = await checkpointWebhook(checkpointRequest);
    expect(checkpointResponse.status).toBe(200);
  }

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

    it("should reject negative lastEventSequence", async () => {
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
            lastEventSequence: -1,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("lastEventSequence");
    });

    it("should reject lastEventSequence outside the database integer range", async () => {
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
            lastEventSequence: 2_147_483_648,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("lastEventSequence");
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
      await createCheckpoint();

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

    it("should persist lastEventSequence without waiting in the response path", async () => {
      await createCheckpoint();

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
            lastEventSequence: 2,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const run = await findTestRunRecord(testRunId);
      expect(run!.status).toBe("completed");
      expect(run!.lastEventSequence).toBe(2);

      await context.mocks.flushAfter();

      expect(context.mocks.axiom.queryAxiom).not.toHaveBeenCalled();
    });

    it("should complete when Axiom query would fail", async () => {
      await createCheckpoint();
      context.mocks.axiom.queryAxiom.mockRejectedValueOnce(
        new Error("axiom unavailable"),
      );

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
            lastEventSequence: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const run = await findTestRunRecord(testRunId);
      expect(run!.status).toBe("completed");
      expect(run!.lastEventSequence).toBe(0);
      expect(context.mocks.axiom.queryAxiom).not.toHaveBeenCalled();
    });

    it("should not query Axiom when watermark is absent", async () => {
      await createCheckpoint();

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
      expect(context.mocks.axiom.queryAxiom).not.toHaveBeenCalled();
    });

    it("should project array-shape artifactSnapshots to Record in result.artifact", async () => {
      // Post-#10911 guest-agents emit Array<{name, version, mountPath}>.
      // RunResult.artifact is still Record-shaped for downstream consumers,
      // so the complete-webhook must normalise on the way out.
      const arrayShape = [
        {
          name: "frontend-build",
          version: "v-frontend-1",
          mountPath: "/workspace/fe",
        },
        {
          name: "backend-build",
          version: "v-backend-2",
          mountPath: "/workspace/be",
        },
      ];

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
            cliAgentSessionId: "array-shape-complete",
            cliAgentSessionHistoryHash:
              "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
            artifactSnapshots: arrayShape,
          }),
        },
      );
      const checkpointResponse = await checkpointWebhook(checkpointRequest);
      expect(checkpointResponse.status).toBe(200);

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

      const run = await findTestRunRecord(testRunId);
      expect(run!.status).toBe("completed");
      const result = run!.result as { artifact?: Record<string, string> };
      expect(result.artifact).toEqual({
        "frontend-build": "v-frontend-1",
        "backend-build": "v-backend-2",
      });
    });

    it("should store fallback error when body.error is missing on failed completion", async () => {
      // Create run directly in DB in running state to avoid runner_job_queue issues
      const { runId } = await seedTestRun(user.userId, testComposeId, {
        status: "running",
        prompt: "Test prompt",
      });
      const token = await createTestSandboxToken(user.userId, runId);

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
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("failed");

      // Without body.error, stored error is the fallback string. The frontend's
      // formatChatRunErrorMessage handles UI rendering; the column is debug-only.
      const run = await findTestRunRecord(runId);
      expect(run!.error).toBe("Run failed without error message");
    });

    it("should preserve body.error verbatim in agent_runs.error (#12077)", async () => {
      // Create run directly in DB in running state to avoid runner_job_queue issues
      const { runId } = await seedTestRun(user.userId, testComposeId, {
        status: "running",
        prompt: "Test prompt",
      });
      const token = await createTestSandboxToken(user.userId, runId);

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
            exitCode: 127,
            error: "unable to load auth.json: refresh_token cannot be empty",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("failed");

      // body.error must be stored verbatim — frontend transforms it for UI
      // display via formatChatRunErrorMessage, so the column itself is the
      // debuggable underlying error. Without this, engineers cannot diagnose
      // production failures from agent_runs alone.
      const run = await findTestRunRecord(runId);
      expect(run!.error).toBe(
        "unable to load auth.json: refresh_token cannot be empty",
      );
      // The old report-error template should NOT appear in the column.
      expect(run!.error).not.toContain("/report-error");
    });

    it("should not wait for Axiom visibility on failed completion", async () => {
      const { runId } = await seedTestRun(user.userId, testComposeId, {
        status: "running",
        prompt: "Test prompt",
      });
      const token = await createTestSandboxToken(user.userId, runId);

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
            lastEventSequence: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const run = await findTestRunRecord(runId);
      expect(run!.lastEventSequence).toBe(0);
      expect(context.mocks.axiom.queryAxiom).not.toHaveBeenCalled();
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

    it("should persist lastEventSequence when checkpoint is missing", async () => {
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
            lastEventSequence: 4,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const run = await findTestRunRecord(testRunId);
      expect(run!.status).toBe("failed");
      expect(run!.lastEventSequence).toBe(4);
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

    it("should persist a late lastEventSequence for already completed run", async () => {
      await completeTestRun(user.userId, testRunId);

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
            lastEventSequence: 7,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const run = await findTestRunRecord(testRunId);
      expect(run!.lastEventSequence).toBe(7);
      expect(context.mocks.axiom.queryAxiom).not.toHaveBeenCalled();
    });

    it("should not lower an existing lastEventSequence on duplicate complete", async () => {
      await completeTestRun(user.userId, testRunId);

      const higherRequest = createTestRequest(
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
            lastEventSequence: 7,
          }),
        },
      );

      const firstResponse = await POST(higherRequest);
      expect(firstResponse.status).toBe(200);

      const lowerRequest = createTestRequest(
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
            lastEventSequence: 3,
          }),
        },
      );

      const response = await POST(lowerRequest);

      expect(response.status).toBe(200);
      const run = await findTestRunRecord(testRunId);
      expect(run!.lastEventSequence).toBe(7);
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

    it("should persist a late lastEventSequence for already failed run", async () => {
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
            lastEventSequence: 7,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("failed");
      const run = await findTestRunRecord(testRunId);
      expect(run!.lastEventSequence).toBe(7);
      expect(context.mocks.axiom.queryAxiom).not.toHaveBeenCalled();
    });

    it("should return failed when completion loses the transition race to cancellation", async () => {
      await createCheckpoint();
      const cancelled = await transitionRunStatus(
        testRunId,
        {
          status: "cancelled",
          completedAt: new Date(),
        },
        ["pending", "running"],
      );
      expect(cancelled).toBe(true);

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
      expect(data.status).toBe("failed");
      const run = await findTestRunRecord(testRunId);
      expect(run!.status).toBe("cancelled");
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

    it("should dispatch callback with the runner's real error string", async () => {
      let capturedBody: { error?: string } | undefined;

      // Intercept the callback request with MSW
      server.use(
        http.post(
          "http://localhost/api/internal/callbacks/test",
          async ({ request }) => {
            capturedBody = (await request.json()) as { error?: string };
            return HttpResponse.json({ success: true });
          },
        ),
      );

      // Register a callback for this run
      await createTestCallback({
        runId: testRunId,
        url: "http://localhost/api/internal/callbacks/test",
        payload: { testKey: "testValue" },
      });

      // Fail the run with a runner-supplied stderr message (#12077)
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
            error: "codex exec exited with status 1",
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      // Callbacks now receive the underlying error verbatim (the user-facing
      // formatting happens at frontend display time, not in callback dispatch).
      expect(capturedBody).toBeDefined();
      expect(capturedBody!.error).toBe("codex exec exited with status 1");
    });

    it("should register an after() callback for dispatch", async () => {
      // Clear callbacks accumulated by fixture setup and earlier API helpers.
      resetNextAfterHooks();

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

      // The route registers dispatchCallbacks; ts-rest may also queue telemetry.
      expect(nextAfterCallbacks.length).toBeGreaterThanOrEqual(1);
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
      const { composeId, agentId } = await createTestCompose(
        uniqueId("reply-agent"),
      );
      const agentSession = await createTestAgentSession(
        emailUser.userId,
        composeId,
      );
      const replyToken = generateReplyToken(agentSession.id);

      const emailSession = await createTestEmailThreadSession({
        userId: emailUser.userId,
        agentId,
        agentSessionId: agentSession.id,
        replyToToken: replyToken,
        lastEmailMessageId: "<original-msg-id@vm7.bot>",
      });

      const { runId } = await createTestRun(composeId, "Email reply task");

      // Register a callback (as the inbound-reply handler now does)
      await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/reply",
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

    it("should drain queued run after completion", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Use a separate user to avoid concurrency interference
      const qUser = await context.setupUser({ prefix: "queue-drain" });
      mockClerk({ userId: qUser.userId });
      const { composeId, versionId } = await createTestCompose(
        uniqueId("drain-agent"),
      );

      // First run claims the slot
      const run1 = await createTestRun(composeId, "First run");
      expect(run1.status).toBe("pending");

      // Enqueue a run with proper encrypted params (startRun no longer enqueues)
      const run2 = await enqueueTestRun({
        userId: qUser.userId,
        agentComposeVersionId: versionId,
        prompt: "Queued run",
        orgId: qUser.orgId,
        composeId,
      });
      expect(run2.status).toBe("queued");

      // Verify queue entry exists
      const queueBefore = await findTestQueueEntry(run2.runId);
      expect(queueBefore).toBeDefined();

      // Complete the first run via webhook
      const token = await createTestSandboxToken(qUser.userId, run1.runId);
      mockClerk({ userId: null });

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId: run1.runId,
            exitCode: 1,
            error: "Done",
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Flush the after() callback which triggers drainOrgQueue
      await context.mocks.flushAfter();

      // Queued run should now be dispatched (pending)
      const run2After = await findTestRunRecord(run2.runId);
      expect(run2After!.status).toBe("pending");

      // Queue entry should be deleted
      const queueAfter = await findTestQueueEntry(run2.runId);
      expect(queueAfter).toBeUndefined();
    });

    it("should dispatch schedule callbacks when registered", async () => {
      // Use a separate user for concurrency
      const schedUser = await context.setupUser({ prefix: "sched-cb" });
      mockClerk({ userId: schedUser.userId });
      const agentName = uniqueId("sched-agent");
      const { composeId } = await createTestCompose(agentName);
      await createTestZeroAgent(schedUser.orgId, agentName, {});
      const schedule = await createTestSchedule(composeId, uniqueId("sched"));
      const { runId } = await createTestRun(composeId, "Scheduled task");
      await linkRunToSchedule(runId, schedule.id);

      // Register callbacks (as executeSchedule now does)
      await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/schedule",
        payload: {
          scheduleId: schedule.id,
          agentId: schedule.agentId,
          agentName,
          userId: schedUser.userId,
        },
      });
      await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack/org/schedule",
        payload: {
          scheduleId: schedule.id,
          agentId: schedule.agentId,
          agentName,
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
      expect(
        callbacks.every((c) => {
          return c.attempts === 1;
        }),
      ).toBe(true);
    });
  });

  describe("Sandbox reuse outcome", () => {
    it("should persist sandboxId and reuse outcome when reuse succeeded", async () => {
      const { runId } = await seedTestRun(user.userId, testComposeId, {
        status: "running",
      });
      const token = await createTestSandboxToken(user.userId, runId);
      const sandboxId = randomUUID();

      const response = await POST(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId,
            exitCode: 1,
            sandboxId,
            sandboxReuseResult: "reused",
          }),
        }),
      );
      expect(response.status).toBe(200);

      const run = await findTestRunRecord(runId);
      expect(run!.sandboxId).toBe(sandboxId);
      expect(run!.sandboxReuseResult).toBe("reused");
    });

    it("should persist sandboxId and reuse outcome when reuse was blocked", async () => {
      const { runId } = await seedTestRun(user.userId, testComposeId, {
        status: "running",
      });
      const token = await createTestSandboxToken(user.userId, runId);
      const sandboxId = randomUUID();

      const response = await POST(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId,
            exitCode: 1,
            sandboxId,
            sandboxReuseResult: "poolMiss",
          }),
        }),
      );
      expect(response.status).toBe(200);

      const run = await findTestRunRecord(runId);
      expect(run!.sandboxId).toBe(sandboxId);
      expect(run!.sandboxReuseResult).toBe("poolMiss");
    });

    it("should leave sandboxId and reuse outcome null when fields are omitted", async () => {
      // Backwards-compat: old runners post without the new fields.
      const { runId } = await seedTestRun(user.userId, testComposeId, {
        status: "running",
      });
      const token = await createTestSandboxToken(user.userId, runId);

      const response = await POST(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId,
            exitCode: 1,
          }),
        }),
      );
      expect(response.status).toBe(200);

      const run = await findTestRunRecord(runId);
      expect(run!.sandboxId).toBeNull();
      expect(run!.sandboxReuseResult).toBeNull();
    });

    it("should reject invalid sandboxReuseResult value", async () => {
      const response = await POST(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
            sandboxReuseResult: "someInvalidValue",
          }),
        }),
      );
      expect(response.status).toBe(400);
    });
  });

  // Race between cleanup-sandboxes cron and webhook/complete: the cron stamps
  // `timeout` first with a generic heartbeat message, then the sandbox's own
  // completion webhook arrives. The webhook must upgrade the run state and
  // overwrite the cron's stale message with the runner's actual error string.
  describe("Timeout upgrade", () => {
    it("should upgrade timed-out run to failed with the runner's error", async () => {
      const threadId = await insertTestChatThread(
        user.userId,
        testComposeId,
        "Timeout upgrade thread",
      );
      const { runId } = await seedTestRun(user.userId, testComposeId, {
        status: "running",
      });
      await addTestRunToThread(threadId, runId, user.userId);

      // Simulate the cleanup cron stamping timeout on the run.
      const cronMessage = "Run timed out (no heartbeat)";
      await transitionRunStatus(
        runId,
        {
          status: "timeout",
          completedAt: new Date(),
          error: cronMessage,
        },
        ["pending", "running"],
      );

      // Sandbox finally reports a failure with its own real stderr → webhook
      // must override the timeout state and replace the cron's stale message
      // with the runner-supplied error (#12077).
      const token = await createTestSandboxToken(user.userId, runId);
      const response = await POST(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId,
            exitCode: 1,
            error: "sandbox terminated mid-execution",
          }),
        }),
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe("failed");

      // agent_runs state upgraded: status=failed, error carries the runner's
      // real message and not the cron's stale one.
      const run = await findTestRunRecord(runId);
      expect(run!.status).toBe("failed");
      expect(run!.error).toBe("sandbox terminated mid-execution");
      expect(run!.error).not.toContain("Run timed out");
    });

    it("should upgrade timed-out run to completed", async () => {
      const threadId = await insertTestChatThread(
        user.userId,
        testComposeId,
        "Timeout recovery thread",
      );
      const { runId } = await seedTestRun(user.userId, testComposeId, {
        status: "running",
      });
      await addTestRunToThread(threadId, runId, user.userId);

      const cronMessage = "Run timed out (no heartbeat)";
      await transitionRunStatus(
        runId,
        {
          status: "timeout",
          completedAt: new Date(),
          error: cronMessage,
        },
        ["pending", "running"],
      );

      // Checkpoint is required for exitCode=0 completion.
      const token = await createTestSandboxToken(user.userId, runId);
      const checkpointResponse = await checkpointWebhook(
        createTestRequest(
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
              cliAgentSessionId: "recovery-session",
              cliAgentSessionHistoryHash:
                "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
              artifactSnapshots: [
                {
                  name: "recovery-artifact",
                  version: "v1",
                  mountPath: "/home/user/workspace",
                },
              ],
            }),
          },
        ),
      );
      expect(checkpointResponse.status).toBe(200);

      const response = await POST(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId,
            exitCode: 0,
          }),
        }),
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe("completed");

      const run = await findTestRunRecord(runId);
      expect(run!.status).toBe("completed");
    });
  });

  // Terminal completion kicks processOrgUsageEvents() inside the after()
  // block so connector-kind charges drain immediately instead of waiting
  // up to a minute for the API usage-event cron. This test verifies the
  // inline wiring from the complete webhook.
  describe("Usage event settlement", () => {
    it("settles pending usage_event rows inline in the after() block", async () => {
      await insertTestUsagePricing({
        kind: "connector",
        provider: "x",
        category: "tweet.read",
        unitPrice: 10,
        unitSize: 1,
      });
      await setOrgCredits(user.orgId, 1000);

      const eventId = await insertTestUsageEvent(user.orgId, {
        userId: user.userId,
        kind: "connector",
        provider: "x",
        category: "tweet.read",
        quantity: 3,
      });

      const response = await POST(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
          }),
        }),
      );
      expect(response.status).toBe(200);

      // Before flushing after(): usage_event must still be pending,
      // which proves the settlement runs in the after() block, not
      // inside the request handler.
      const beforeFlush = await findTestUsageEvent(eventId);
      expect(beforeFlush!.status).toBe("pending");

      await context.mocks.flushAfter();

      const afterFlush = await findTestUsageEvent(eventId);
      expect(afterFlush!.status).toBe("processed");
      expect(afterFlush!.creditsCharged).toBe(30);
      expect(afterFlush!.billingError).toBeNull();
      expect(afterFlush!.processedAt).toBeInstanceOf(Date);

      const credits = await getOrgCredits(user.orgId);
      expect(credits).toBe(970);
    });
  });
});
