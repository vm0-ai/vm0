import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { POST as createComposeJob } from "../../../../compose/from-github/route";
import { GET as getComposeJob } from "../../../../compose/from-github/[jobId]/route";
import {
  createTestRequest,
  createTestComposeJobToken,
  createTestCliToken,
  createTestSlackComposeRequest,
  findTestSlackComposeRequest,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { givenLinkedSlackUser } from "../../../../../../src/__tests__/slack/api-helpers";
import { triggerComposeJob } from "../../../../../../src/lib/compose/trigger-compose-job";
import { Sandbox } from "@e2b/code-interpreter";
import { randomUUID } from "crypto";
import { WebClient } from "@slack/web-api";

const context = testContext();

/**
 * Helper to create a compose job via API and return jobId and token
 */
async function createTestComposeJobViaApi(
  userId: string,
  githubUrl: string = "https://github.com/owner/repo",
): Promise<{ jobId: string; token: string }> {
  // Create CLI token for authenticated request
  const cliToken = await createTestCliToken(userId);

  const request = createTestRequest(
    "http://localhost:3000/api/compose/from-github",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cliToken}`,
      },
      body: JSON.stringify({ githubUrl }),
    },
  );
  const response = await createComposeJob(request);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Failed to create compose job: ${data.error?.message}`);
  }

  const token = await createTestComposeJobToken(userId, data.jobId);
  return { jobId: data.jobId, token };
}

/**
 * Helper to get compose job status via API
 */
async function getTestComposeJobViaApi(
  jobId: string,
  userId: string,
): Promise<{
  jobId: string;
  status: string;
  result?: {
    composeId: string;
    composeName: string;
    versionId: string;
    warnings: string[];
  };
  error?: string;
  completedAt?: string;
}> {
  // Create CLI token for authenticated request
  const cliToken = await createTestCliToken(userId);

  const request = createTestRequest(
    `http://localhost:3000/api/compose/from-github/${jobId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cliToken}`,
      },
    },
  );
  const response = await getComposeJob(request);
  return response.json();
}

/**
 * Helper to complete a compose job via webhook
 */
async function completeComposeJobViaWebhook(
  jobId: string,
  token: string,
  success: boolean,
  resultOrError?: {
    result?: {
      composeId: string;
      composeName: string;
      versionId: string;
      warnings: string[];
    };
    error?: string;
  },
): Promise<void> {
  const body: Record<string, unknown> = { jobId, success };
  if (success && resultOrError?.result) {
    body.result = resultOrError.result;
  }
  if (!success && resultOrError?.error) {
    body.error = resultOrError.error;
  }

  const request = createTestRequest(
    "http://localhost:3000/api/webhooks/compose/complete",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
  );
  const response = await POST(request);
  if (!response.ok) {
    const data = await response.json();
    throw new Error(`Failed to complete compose job: ${data.error?.message}`);
  }
}

describe("POST /api/webhooks/compose/complete", () => {
  let user: UserContext;
  let testJobId: string;
  let testToken: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create a test job via API
    const { jobId, token } = await createTestComposeJobViaApi(
      user.userId,
      "https://github.com/owner/repo",
    );
    testJobId = jobId;
    testToken = token;

    // Reset auth mock for webhook tests (which use token auth, not Clerk)
    mockClerk({ userId: null });
  });

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId: testJobId,
            success: true,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it("should reject request with invalid token", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer invalid-token",
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: true,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it("should reject request when token jobId does not match", async () => {
      const differentJobId = randomUUID();

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: differentJobId, // Different from token
            success: true,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.message).toContain("Token does not match");
    });
  });

  describe("Validation", () => {
    it("should reject request without jobId", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            success: true,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("jobId");
    });

    it("should reject request without success flag", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("success");
    });
  });

  describe("Success Completion", () => {
    it("should handle successful completion", async () => {
      const result = {
        composeId: "test-compose-id",
        composeName: "test-compose",
        versionId: "test-version-id",
        warnings: [],
      };

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: true,
            result,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify job was updated via API
      const job = await getTestComposeJobViaApi(testJobId, user.userId);

      expect(job.status).toBe("completed");
      expect(job.result).toEqual(result);
      expect(job.completedAt).toBeDefined();
    });

    it("should handle successful completion with warnings", async () => {
      const result = {
        composeId: "test-compose-id",
        composeName: "test-compose",
        versionId: "test-version-id",
        warnings: ["Some deprecated field used"],
      };

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: true,
            result,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);

      // Verify warnings were stored via API
      const job = await getTestComposeJobViaApi(testJobId, user.userId);

      expect(job.result?.warnings).toEqual(["Some deprecated field used"]);
    });
  });

  describe("Failed Completion", () => {
    it("should handle failed completion with error", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: false,
            error: "Failed to parse vm0.yaml",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify job was updated via API
      const job = await getTestComposeJobViaApi(testJobId, user.userId);

      expect(job.status).toBe("failed");
      expect(job.error).toBe("Failed to parse vm0.yaml");
      expect(job.completedAt).toBeDefined();
    });
  });

  describe("Idempotency", () => {
    it("should accept duplicate success completion", async () => {
      const originalResult = {
        composeId: "original-compose-id",
        composeName: "test-compose",
        versionId: "original-version-id",
        warnings: [],
      };

      // Complete job first via webhook
      await completeComposeJobViaWebhook(testJobId, testToken, true, {
        result: originalResult,
      });

      // Try to complete again with different result
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: true,
            result: {
              composeId: "different-compose-id",
              composeName: "different-compose",
              versionId: "different-version-id",
              warnings: [],
            },
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify original result was not changed via API
      const job = await getTestComposeJobViaApi(testJobId, user.userId);

      expect(job.result?.composeId).toBe("original-compose-id");
    });

    it("should accept duplicate failed completion", async () => {
      // Fail job first via webhook
      await completeComposeJobViaWebhook(testJobId, testToken, false, {
        error: "Original error",
      });

      // Try to fail again with different error
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: false,
            error: "Different error",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify original error was not changed via API
      const job = await getTestComposeJobViaApi(testJobId, user.userId);

      expect(job.error).toBe("Original error");
    });
  });

  describe("Slack Notification", () => {
    it("should send Slack notification on success for Slack-initiated job", async () => {
      // Set up a linked Slack user
      const { userLink, installation } = await givenLinkedSlackUser();

      // Create a compose job for this user
      const cliToken = await createTestCliToken(userLink.vm0UserId);
      mockClerk({ userId: null });

      const createRequest = createTestRequest(
        "http://localhost:3000/api/compose/from-github",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cliToken}`,
          },
          body: JSON.stringify({
            githubUrl: "https://github.com/owner/slack-test-repo",
          }),
        },
      );
      const createResponse = await createComposeJob(createRequest);
      const createData = await createResponse.json();
      const jobId = createData.jobId;

      // Insert slack_compose_requests record (simulating what the Slack handler does)
      await createTestSlackComposeRequest({
        composeJobId: jobId,
        slackWorkspaceId: installation.slackWorkspaceId,
        slackUserId: userLink.slackUserId,
        slackChannelId: "C-test-channel",
      });

      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.chat.postEphemeral.mockClear();

      // Complete the job via webhook
      const token = await createTestComposeJobToken(userLink.vm0UserId, jobId);
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jobId,
            success: true,
            result: {
              composeId: "test-compose-id",
              composeName: "my-agent",
              versionId: "test-version-id",
              warnings: [],
            },
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Verify Slack notification was sent
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C-test-channel",
          user: userLink.slackUserId,
        }),
      );

      // Verify slack_compose_requests record was cleaned up
      const remaining = await findTestSlackComposeRequest(jobId);
      expect(remaining).toBeUndefined();
    });

    it("should NOT send Slack notification for non-Slack jobs", async () => {
      // This test uses the default testJobId which has no slack_compose_requests record
      const result = {
        composeId: "test-compose-id",
        composeName: "test-compose",
        versionId: "test-version-id",
        warnings: [],
      };

      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.chat.postEphemeral.mockClear();

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: true,
            result,
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Verify Slack notification was NOT sent
      expect(mockClient.chat.postEphemeral).not.toHaveBeenCalled();
    });

    it("should send Slack failure notification when sandbox creation fails", async () => {
      // Set up a linked Slack user
      const { userLink, installation } = await givenLinkedSlackUser();

      // Use a deferred promise so we can control when Sandbox.create rejects.
      // This ensures the slack_compose_requests record is inserted before the
      // failure handler runs.
      let rejectSandbox!: (err: Error) => void;
      const sandboxPromise = new Promise<never>((_resolve, reject) => {
        rejectSandbox = reject;
      });
      const mockCreate = vi.mocked(Sandbox.create);
      mockCreate.mockReturnValueOnce(sandboxPromise);

      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.chat.postEphemeral.mockClear();

      // Trigger compose job (sandbox creation is pending)
      const result = await triggerComposeJob({
        userId: userLink.vm0UserId,
        githubUrl: "https://github.com/owner/failing-repo",
        userToken: "test-token",
      });

      // Insert slack_compose_requests record (simulating what Slack handler does)
      await createTestSlackComposeRequest({
        composeJobId: result.jobId,
        slackWorkspaceId: installation.slackWorkspaceId,
        slackUserId: userLink.slackUserId,
        slackChannelId: "C-test-channel",
      });

      // Now reject the sandbox creation — this triggers the failure handler
      rejectSandbox(new Error("E2B API unavailable"));

      // Wait for the fire-and-forget catch handler to complete
      await vi.waitFor(
        () => {
          expect(mockClient.chat.postEphemeral).toHaveBeenCalled();
        },
        { timeout: 5000 },
      );

      // Verify slack_compose_requests record was cleaned up
      const remaining = await findTestSlackComposeRequest(result.jobId);
      expect(remaining).toBeUndefined();
    });
  });

  describe("Errors", () => {
    it("should return 404 for non-existent job", async () => {
      const nonExistentId = randomUUID();
      const tokenForNonExistent = await createTestComposeJobToken(
        user.userId,
        nonExistentId,
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenForNonExistent}`,
          },
          body: JSON.stringify({
            jobId: nonExistentId,
            success: true,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });
});
