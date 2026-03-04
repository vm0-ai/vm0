import crypto from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../src/mocks/server";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { givenGitHubInstallation } from "../../../../../src/__tests__/github/api-helpers";
import {
  createTestScope,
  createTestCompose,
  insertTestPendingGitHubInstallation,
  findTestGitHubInstallationsByUserId,
} from "../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { POST } from "../route";
import * as runModule from "../../../../../src/lib/run";
import { reloadEnv } from "../../../../../src/env";

// Note: createRun is spied on (rather than exercised with real DB + executor)
// because this test file focuses on the webhook routing layer: signature
// verification, event routing, trigger conditions, and callback context
// construction.  Real createRun integration is covered by its own dedicated
// tests in src/lib/run/__tests__/create-run.test.ts.  The same boundary is
// used in the Slack webhook tests (slack/handlers/__tests__/run-agent.test.ts).

// Mock Next.js after() to capture callbacks for controlled execution
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

const context = testContext();

const TEST_WEBHOOK_SECRET = "test-github-webhook-secret";
const TEST_APP_SLUG = "vm0-bot";

/** Wait for all after() callbacks to complete */
async function flushAfterCallbacks() {
  await Promise.all(afterPromises);
  afterPromises.length = 0;
}

/** Sign a payload with HMAC-SHA256 matching GitHub's format */
function signPayload(body: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  return `sha256=${hmac.update(body).digest("hex")}`;
}

/** Create a signed GitHub webhook request */
function createGitHubWebhookRequest(
  event: string,
  payload: Record<string, unknown>,
  options?: { invalidSignature?: boolean; missingHeaders?: boolean },
): Request {
  const body = JSON.stringify(payload);
  const signature = options?.invalidSignature
    ? "sha256=invalid"
    : signPayload(body, TEST_WEBHOOK_SECRET);
  const deliveryId = crypto.randomUUID();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (!options?.missingHeaders) {
    headers["x-hub-signature-256"] = signature;
    headers["x-github-event"] = event;
    headers["x-github-delivery"] = deliveryId;
  }

  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers,
    body,
  });
}

interface IssuesPayloadOverrides {
  action?: string;
  labels?: Array<{ id: number; name: string }>;
  label?: { id: number; name: string };
  installationId?: number;
  repo?: string;
  issueBody?: string | null;
}

/** Build a GitHub issues event payload */
function buildIssuesPayload(overrides?: IssuesPayloadOverrides) {
  return {
    action: overrides?.action ?? "opened",
    issue: {
      number: 42,
      title: "Test Issue",
      body:
        overrides?.issueBody !== undefined
          ? overrides.issueBody
          : "This is a test issue body",
      labels: overrides?.labels ?? [{ id: 1, name: "vm0-agent" }],
      user: { id: 100, login: "testuser", type: "User" },
    },
    ...(overrides?.label && { label: overrides.label }),
    repository: { full_name: overrides?.repo ?? "owner/repo" },
    installation: { id: overrides?.installationId ?? 12345 },
    sender: { id: 100, login: "testuser", type: "User" },
  };
}

interface CommentPayloadOverrides {
  action?: string;
  labels?: Array<{ id: number; name: string }>;
  commentBody?: string;
  commentId?: number;
  installationId?: number;
  repo?: string;
  senderType?: string;
  senderLogin?: string;
}

/** Build a GitHub issue_comment event payload */
function buildIssueCommentPayload(overrides?: CommentPayloadOverrides) {
  const senderLogin = overrides?.senderLogin ?? "testuser";
  const senderType = overrides?.senderType ?? "User";

  return {
    action: overrides?.action ?? "created",
    issue: {
      number: 42,
      title: "Test Issue",
      body: "This is a test issue body",
      labels: overrides?.labels ?? [{ id: 1, name: "vm0-agent" }],
      user: { id: 100, login: "testuser", type: "User" },
    },
    comment: {
      id: overrides?.commentId ?? 999,
      body: overrides?.commentBody ?? "Please help with this",
      user: { id: 100, login: senderLogin, type: senderType },
    },
    repository: { full_name: overrides?.repo ?? "owner/repo" },
    installation: { id: overrides?.installationId ?? 12345 },
    sender: { id: 100, login: senderLogin, type: senderType },
  };
}

describe("POST /api/webhooks/github", () => {
  let createRunSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    afterPromises.length = 0;
    context.setupMocks();

    // Stub GitHub App env vars
    vi.stubEnv("GITHUB_APP_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
    vi.stubEnv("GITHUB_APP_SLUG", TEST_APP_SLUG);

    // Reload env after stubbing
    reloadEnv();

    // Mock createRun to prevent actual sandbox dispatch
    createRunSpy = vi.spyOn(runModule, "createRun").mockResolvedValue({
      runId: "test-run-id",
      status: "running",
      createdAt: new Date(),
    });
  });

  describe("Signature Verification", () => {
    it("should reject request with missing headers", async () => {
      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload(),
        { missingHeaders: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain("Missing");
    });

    it("should reject request with invalid signature", async () => {
      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload(),
        { invalidSignature: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain("Invalid signature");
    });

    it("should accept request with valid signature", async () => {
      const request = createGitHubWebhookRequest("ping", { zen: "test" });
      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe("Ping Event", () => {
    it("should respond with pong", async () => {
      const request = createGitHubWebhookRequest("ping", {
        zen: "Anything added dilutes everything else.",
      });
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.message).toBe("pong");
    });
  });

  describe("Issues Event", () => {
    it("should trigger agent for opened issue with vm0-agent label", async () => {
      // Given a GitHub installation exists
      const { ghInstallationId } = await givenGitHubInstallation();

      // When a webhook arrives for an opened issue with the vm0-agent label
      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload({
          action: "opened",
          labels: [{ id: 1, name: "vm0-agent" }],
          installationId: ghInstallationId,
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await flushAfterCallbacks();

      // Then createRun should have been called
      expect(createRunSpy).toHaveBeenCalledTimes(1);
      const callArgs = createRunSpy.mock.calls[0]![0] as {
        prompt: string;
        callbacks: Array<{ payload: { issueNumber: number } }>;
      };
      expect(callArgs.prompt).toContain("Test Issue");
      expect(callArgs.prompt).toContain("test issue body");
      expect(callArgs.callbacks[0]!.payload.issueNumber).toBe(42);
    });

    it("should trigger agent when vm0-agent label is added", async () => {
      const { ghInstallationId } = await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload({
          action: "labeled",
          labels: [{ id: 1, name: "vm0-agent" }],
          label: { id: 1, name: "vm0-agent" },
          installationId: ghInstallationId,
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await flushAfterCallbacks();

      expect(createRunSpy).toHaveBeenCalledTimes(1);
    });

    it("should NOT trigger agent for opened issue without vm0-agent label", async () => {
      const { ghInstallationId } = await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload({
          action: "opened",
          labels: [{ id: 2, name: "bug" }],
          installationId: ghInstallationId,
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await flushAfterCallbacks();

      expect(createRunSpy).not.toHaveBeenCalled();
    });

    it("should NOT trigger agent when a non-vm0-agent label is added", async () => {
      const { ghInstallationId } = await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload({
          action: "labeled",
          labels: [
            { id: 1, name: "vm0-agent" },
            { id: 2, name: "enhancement" },
          ],
          label: { id: 2, name: "enhancement" },
          installationId: ghInstallationId,
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await flushAfterCallbacks();

      expect(createRunSpy).not.toHaveBeenCalled();
    });

    it("should ignore closed/edited/other issue actions", async () => {
      const { ghInstallationId } = await givenGitHubInstallation();

      for (const action of ["closed", "edited", "reopened", "deleted"]) {
        createRunSpy.mockClear();

        const request = createGitHubWebhookRequest(
          "issues",
          buildIssuesPayload({
            action,
            labels: [{ id: 1, name: "vm0-agent" }],
            installationId: ghInstallationId,
          }),
        );
        const response = await POST(request);
        expect(response.status).toBe(200);

        await flushAfterCallbacks();

        expect(createRunSpy).not.toHaveBeenCalled();
      }
    });

    it("should handle issue with null body", async () => {
      const { ghInstallationId } = await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload({
          action: "opened",
          labels: [{ id: 1, name: "vm0-agent" }],
          installationId: ghInstallationId,
          issueBody: null,
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await flushAfterCallbacks();

      expect(createRunSpy).toHaveBeenCalledTimes(1);
      const callArgs = createRunSpy.mock.calls[0]![0] as { prompt: string };
      expect(callArgs.prompt).toContain("No description provided");
    });
  });

  describe("Issue Comment Event", () => {
    it("should trigger agent for comment on issue with vm0-agent label", async () => {
      const { ghInstallationId } = await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issue_comment",
        buildIssueCommentPayload({
          labels: [{ id: 1, name: "vm0-agent" }],
          commentBody: "Can you help me fix this?",
          installationId: ghInstallationId,
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await flushAfterCallbacks();

      expect(createRunSpy).toHaveBeenCalledTimes(1);
      const callArgs = createRunSpy.mock.calls[0]![0] as { prompt: string };
      expect(callArgs.prompt).toContain("Can you help me fix this?");
      expect(callArgs.prompt).toContain("Test Issue");
    });

    it("should trigger agent for comment mentioning @bot", async () => {
      const { ghInstallationId } = await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issue_comment",
        buildIssueCommentPayload({
          labels: [], // No vm0-agent label
          commentBody: `@${TEST_APP_SLUG}[bot] please review this`,
          installationId: ghInstallationId,
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await flushAfterCallbacks();

      expect(createRunSpy).toHaveBeenCalledTimes(1);
    });

    it("should NOT trigger for comment without label or mention", async () => {
      const { ghInstallationId } = await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issue_comment",
        buildIssueCommentPayload({
          labels: [{ id: 2, name: "bug" }],
          commentBody: "Just a regular comment",
          installationId: ghInstallationId,
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await flushAfterCallbacks();

      expect(createRunSpy).not.toHaveBeenCalled();
    });

    it("should prevent self-triggering from bot comments", async () => {
      const { ghInstallationId } = await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issue_comment",
        buildIssueCommentPayload({
          labels: [{ id: 1, name: "vm0-agent" }],
          commentBody: "Here is the analysis...",
          senderType: "Bot",
          senderLogin: `${TEST_APP_SLUG}[bot]`,
          installationId: ghInstallationId,
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await flushAfterCallbacks();

      expect(createRunSpy).not.toHaveBeenCalled();
    });

    it("should ignore non-created comment actions", async () => {
      const { ghInstallationId } = await givenGitHubInstallation();

      for (const action of ["edited", "deleted"]) {
        createRunSpy.mockClear();

        const request = createGitHubWebhookRequest(
          "issue_comment",
          buildIssueCommentPayload({
            action,
            labels: [{ id: 1, name: "vm0-agent" }],
            installationId: ghInstallationId,
          }),
        );
        const response = await POST(request);
        expect(response.status).toBe(200);

        await flushAfterCallbacks();

        expect(createRunSpy).not.toHaveBeenCalled();
      }
    });
  });

  describe("Installation Not Found", () => {
    it("should handle missing installation without crashing", async () => {
      // Use an installation ID that doesn't exist in the database
      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload({
          installationId: 99999,
          labels: [{ id: 1, name: "vm0-agent" }],
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // The error thrown in dispatchAgentRun is caught by the .catch() in route.ts
      await flushAfterCallbacks();

      expect(createRunSpy).not.toHaveBeenCalled();
    });
  });

  describe("Unknown Events", () => {
    it("should acknowledge unknown event types with 200", async () => {
      const request = createGitHubWebhookRequest("push", {
        ref: "refs/heads/main",
      });
      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe("Installation Event", () => {
    function buildInstallationPayload(overrides?: {
      action?: string;
      installationId?: number;
      accountId?: number;
      accountType?: string;
    }) {
      return {
        action: overrides?.action ?? "created",
        installation: {
          id: overrides?.installationId ?? 99999,
          account: {
            id: overrides?.accountId ?? 55555,
            type: overrides?.accountType ?? "Organization",
          },
        },
      };
    }

    function setupInstallationTokenMock(installationId: number) {
      server.use(
        http.post(
          `https://api.github.com/app/installations/${installationId}/access_tokens`,
          () => {
            return HttpResponse.json({
              token: "ghs_test_activation_token",
              expires_at: "2099-01-01T00:00:00Z",
            });
          },
        ),
      );
    }

    it("should activate pending installation on installation.created event", async () => {
      const userId = uniqueId("gh-user");
      mockClerk({ userId });
      await createTestScope(uniqueId("gh-scope"));
      const { composeId } = await createTestCompose("gh-webhook-agent");

      const targetId = String(Math.floor(Math.random() * 1_000_000_000));
      const ghInstallationId = Math.floor(Math.random() * 1_000_000_000);

      // Create a pending installation record
      await insertTestPendingGitHubInstallation(userId, composeId, targetId);

      // Set up MSW mock for GitHub token API
      setupInstallationTokenMock(ghInstallationId);

      const request = createGitHubWebhookRequest(
        "installation",
        buildInstallationPayload({
          action: "created",
          installationId: ghInstallationId,
          accountId: Number(targetId),
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await flushAfterCallbacks();

      // Verify the pending installation was activated
      const installations = await findTestGitHubInstallationsByUserId(userId);
      expect(installations).toHaveLength(1);
      const installation = installations[0]!;
      expect(installation.status).toBe("active");
      expect(installation.installationId).toBe(String(ghInstallationId));
      expect(installation.encryptedAccessToken).toBeTruthy();
    });

    it("should be a no-op when no pending installation matches the account", async () => {
      const request = createGitHubWebhookRequest(
        "installation",
        buildInstallationPayload({
          action: "created",
          installationId: 77777,
          accountId: 11111, // No pending record for this account
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Should complete without error (no pending record to activate)
      await flushAfterCallbacks();
    });

    it("should ignore non-created installation actions", async () => {
      const request = createGitHubWebhookRequest(
        "installation",
        buildInstallationPayload({
          action: "deleted",
          installationId: 77777,
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await flushAfterCallbacks();
    });
  });

  describe("Unconfigured GitHub App", () => {
    it("should return 503 when webhook secret is not configured", async () => {
      // Remove the webhook secret
      vi.stubEnv("GITHUB_APP_WEBHOOK_SECRET", "");
      reloadEnv();

      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload(),
      );
      const response = await POST(request);

      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error).toContain("not configured");
    });
  });

  describe("Session Continuity", () => {
    it("should include callback context with session info", async () => {
      const { ghInstallationId } = await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issue_comment",
        buildIssueCommentPayload({
          labels: [{ id: 1, name: "vm0-agent" }],
          commentBody: "Follow-up question",
          installationId: ghInstallationId,
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await flushAfterCallbacks();

      expect(createRunSpy).toHaveBeenCalledTimes(1);
      const callArgs = createRunSpy.mock.calls[0]![0] as {
        callbacks: Array<{
          url: string;
          secret: string;
          payload: {
            repo: string;
            issueNumber: number;
            installationId: string;
          };
        }>;
      };

      // Callback should include GitHub-specific context
      expect(callArgs.callbacks).toHaveLength(1);
      expect(callArgs.callbacks[0]!.url).toContain(
        "/api/internal/callbacks/github",
      );
      expect(callArgs.callbacks[0]!.payload.repo).toBe("owner/repo");
      expect(callArgs.callbacks[0]!.payload.issueNumber).toBe(42);
    });
  });
});
