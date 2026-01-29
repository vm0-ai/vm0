import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
  completeTestRun,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";
import { POST as checkpointWebhook } from "../../checkpoints/route";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

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
    const { composeId } = await createTestCompose(`complete-${Date.now()}`);
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
});
