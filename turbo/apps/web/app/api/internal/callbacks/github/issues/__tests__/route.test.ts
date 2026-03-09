import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../../src/mocks/server";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import {
  createTestRequest,
  createTestScope,
  createTestCompose,
  createTestRun,
  createTestCallback,
  createTestAgentSession,
  insertTestGitHubInstallation,
  insertTestGitHubIssueSession,
  findTestGitHubIssueSession,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { computeHmacSignature } from "../../../../../../../src/lib/callback/hmac";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

const context = testContext();

const TEST_URL = "http://localhost/api/internal/callbacks/github/issues";

interface CallbackPayload {
  installationId: string;
  repo: string;
  issueNumber: number;
  composeId: string;
  agentName: string;
  existingSessionId?: string;
}

/**
 * Create a signed callback request for GitHub issues callback.
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
) {
  const bodyString = JSON.stringify(body);
  const timestamp = options?.expiredTimestamp
    ? Math.floor(Date.now() / 1000) - 600 // 10 minutes ago
    : Math.floor(Date.now() / 1000);

  const signature = options?.invalidSignature
    ? "invalid-signature"
    : computeHmacSignature(bodyString, secret, timestamp);

  return createTestRequest(TEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VM0-Signature": signature,
      "X-VM0-Timestamp": timestamp.toString(),
    },
    body: bodyString,
  });
}

interface CapturedComment {
  owner: string;
  repo: string;
  issueNumber: string;
  body: string;
}

/**
 * Set up MSW handlers for GitHub API (installation token + issue comment).
 * Returns a `capturedComments` array that records every comment POST.
 */
function setupGitHubApiMocks(installationId: string) {
  const capturedComments: CapturedComment[] = [];

  const commentMock = http.post(
    `https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments`,
    async ({ params, request }) => {
      const { body } = (await request.json()) as { body: string };
      capturedComments.push({
        owner: params["owner"] as string,
        repo: params["repo"] as string,
        issueNumber: params["issueNumber"] as string,
        body,
      });
      return HttpResponse.json({ id: 42 });
    },
  );

  const tokenMock = http.post(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    () => {
      return HttpResponse.json({
        token: "ghs_test_token",
        expires_at: "2099-01-01T00:00:00Z",
      });
    },
  );

  server.use(commentMock, tokenMock);
  return { commentMock, tokenMock, capturedComments };
}

/**
 * Create a full test setup: user, scope, compose, run, GitHub installation, and callback.
 */
async function givenGitHubCallbackSetup(overrides?: {
  existingSessionId?: string;
}) {
  const userId = uniqueId("gh-cb-user");
  mockClerk({ userId });
  await createTestScope(uniqueId("gh-cb-scope"));
  const { composeId } = await createTestCompose("gh-callback-agent");

  const { runId } = await createTestRun(composeId, "Test GitHub prompt");
  const installation = await insertTestGitHubInstallation(composeId);

  const { capturedComments } = setupGitHubApiMocks(
    installation.installationId!,
  );

  const payload: CallbackPayload = {
    installationId: installation.id,
    repo: "test-org/test-repo",
    issueNumber: 42,
    composeId,
    agentName: "gh-callback-agent",
    existingSessionId: overrides?.existingSessionId,
  };

  const { secret } = await createTestCallback({
    runId,
    url: TEST_URL,
    payload: payload as unknown as Record<string, unknown>,
  });

  return {
    userId,
    composeId,
    runId,
    installation,
    payload,
    secret,
    capturedComments,
  };
}

describe("POST /api/internal/callbacks/github/issues", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("Signature Verification", () => {
    it("should reject request with invalid signature", async () => {
      const { runId, payload, secret } = await givenGitHubCallbackSetup();

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
        { invalidSignature: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain("signature");
    });

    it("should reject request with expired timestamp", async () => {
      const { runId, payload, secret } = await givenGitHubCallbackSetup();

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
        { expiredTimestamp: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain("expired");
    });

    it("should reject request for non-existent callback", async () => {
      const request = createTestRequest(TEST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VM0-Signature": "any-signature",
          "X-VM0-Timestamp": Math.floor(Date.now() / 1000).toString(),
        },
        body: JSON.stringify({
          runId: "00000000-0000-0000-0000-000000000001",
          status: "completed",
          payload: {
            installationId: "inst-123",
            repo: "org/repo",
            issueNumber: 1,
            composeId: "compose-123",
          },
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain("not found");
    });
  });

  describe("Validation", () => {
    it("should reject request with missing runId", async () => {
      const request = createTestRequest(TEST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VM0-Signature": "any-signature",
          "X-VM0-Timestamp": Math.floor(Date.now() / 1000).toString(),
        },
        body: JSON.stringify({
          status: "completed",
          payload: {
            installationId: "inst-123",
            repo: "org/repo",
            issueNumber: 1,
            composeId: "compose-123",
          },
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain("runId");
    });

    it("should reject request with invalid payload", async () => {
      const { runId, secret } = await givenGitHubCallbackSetup();

      // Send request with incomplete payload (missing required fields)
      const body = JSON.stringify({
        runId,
        status: "completed",
        payload: {
          installationId: "inst-123",
          // Missing repo, issueNumber, composeId
        },
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = computeHmacSignature(body, secret, timestamp);

      const request = createTestRequest(TEST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VM0-Signature": signature,
          "X-VM0-Timestamp": timestamp.toString(),
        },
        body,
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain("payload");
    });
  });

  describe("Successful Callback", () => {
    it("should post comment to GitHub issue on completed run", async () => {
      const { runId, payload, secret, capturedComments } =
        await givenGitHubCallbackSetup();

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify the comment was posted to the correct repo and issue
      expect(capturedComments).toHaveLength(1);
      expect(capturedComments[0]!.owner).toBe("test-org");
      expect(capturedComments[0]!.repo).toBe("test-repo");
      expect(capturedComments[0]!.issueNumber).toBe("42");
      // Verify the comment body includes the logs footer
      expect(capturedComments[0]!.body).toContain("Audit");
    });

    it("should post error comment on failed run", async () => {
      const { runId, payload, secret, capturedComments } =
        await givenGitHubCallbackSetup();

      const request = createCallbackRequest(
        {
          runId,
          status: "failed",
          error: "Agent crashed unexpectedly",
          payload,
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify the error comment was posted with the error message
      expect(capturedComments).toHaveLength(1);
      expect(capturedComments[0]!.body).toContain("Error");
      expect(capturedComments[0]!.body).toContain("Agent crashed unexpectedly");
      // Verify the comment targets the correct repo and issue
      expect(capturedComments[0]!.owner).toBe("test-org");
      expect(capturedComments[0]!.repo).toBe("test-repo");
      expect(capturedComments[0]!.issueNumber).toBe("42");
    });

    it("should return 404 when GitHub installation is missing", async () => {
      const userId = uniqueId("gh-missing-user");
      mockClerk({ userId });
      await createTestScope(uniqueId("gh-missing-scope"));
      const { composeId } = await createTestCompose("gh-missing-agent");

      const { runId } = await createTestRun(composeId, "Test prompt");

      const payload: CallbackPayload = {
        installationId: "00000000-0000-0000-0000-000000000099",
        repo: "org/repo",
        issueNumber: 1,
        composeId,
        agentName: "gh-missing-agent",
      };

      const { secret } = await createTestCallback({
        runId,
        url: TEST_URL,
        payload: payload as unknown as Record<string, unknown>,
      });

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain("GitHub installation not found");
    });
  });

  describe("Session Management", () => {
    it("should create issue session for new issue on completed run", async () => {
      const { userId, composeId, runId, payload, secret } =
        await givenGitHubCallbackSetup();

      // Create an agent session so findNewSessionId can find it
      const session = await createTestAgentSession(userId, composeId);

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify a github_issue_sessions record was created in the database
      const issueSession = await findTestGitHubIssueSession(
        payload.installationId,
        payload.repo,
        payload.issueNumber,
      );

      expect(issueSession).not.toBeNull();
      expect(issueSession!.agentSessionId).toBe(session.id);
      expect(issueSession!.userId).toBe(userId);
      expect(issueSession!.lastCommentId).toBe("42");
    });

    it("should update lastCommentId for existing session on completed run", async () => {
      const { userId, composeId, runId, installation, payload, secret } =
        await givenGitHubCallbackSetup({
          existingSessionId: "existing-session-id",
        });

      // Pre-insert a github_issue_sessions record to simulate an existing session
      const session = await createTestAgentSession(userId, composeId);
      await insertTestGitHubIssueSession({
        userId,
        installationId: installation.id,
        repo: payload.repo,
        issueNumber: payload.issueNumber,
        agentSessionId: session.id,
        lastCommentId: "old-comment-id",
      });

      const request = createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: { ...payload, existingSessionId: "existing-session-id" },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify the lastCommentId was updated in the database
      const issueSession = await findTestGitHubIssueSession(
        payload.installationId,
        payload.repo,
        payload.issueNumber,
      );

      expect(issueSession).not.toBeNull();
      expect(issueSession!.lastCommentId).toBe("42");
    });
  });
});
