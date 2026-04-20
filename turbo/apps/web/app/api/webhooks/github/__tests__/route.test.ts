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
  createTestOrg,
  createTestCompose,
  insertTestPendingGitHubInstallation,
  findTestGitHubInstallationsByTargetId,
  findMostRecentRunForUser,
  findTestZeroRun,
  findTestRunCallbacks,
} from "../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { POST } from "../route";
import { reloadEnv } from "../../../../../src/env";

const context = testContext();

const TEST_WEBHOOK_SECRET = "test-github-webhook-secret";
const TEST_APP_SLUG = "vm0-bot";

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
  senderId?: number;
}

/** Build a GitHub issues event payload */
function buildIssuesPayload(overrides?: IssuesPayloadOverrides) {
  const senderId = overrides?.senderId ?? 100;
  return {
    action: overrides?.action ?? "opened",
    issue: {
      number: 42,
      title: "Test Issue",
      body:
        overrides?.issueBody !== undefined
          ? overrides.issueBody
          : "This is a test issue body",
      labels: overrides?.labels ?? [{ id: 1, name: TEST_APP_SLUG }],
      user: { id: senderId, login: "testuser", type: "User" },
    },
    ...(overrides?.label && { label: overrides.label }),
    repository: { full_name: overrides?.repo ?? "owner/repo" },
    installation: { id: overrides?.installationId ?? 12345 },
    sender: { id: senderId, login: "testuser", type: "User" },
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
  senderId?: number;
}

/** Build a GitHub issue_comment event payload */
function buildIssueCommentPayload(overrides?: CommentPayloadOverrides) {
  const senderId = overrides?.senderId ?? 100;
  const senderLogin = overrides?.senderLogin ?? "testuser";
  const senderType = overrides?.senderType ?? "User";

  return {
    action: overrides?.action ?? "created",
    issue: {
      number: 42,
      title: "Test Issue",
      body: "This is a test issue body",
      labels: overrides?.labels ?? [{ id: 1, name: TEST_APP_SLUG }],
      user: { id: senderId, login: "testuser", type: "User" },
    },
    comment: {
      id: overrides?.commentId ?? 999,
      body: overrides?.commentBody ?? "Please help with this",
      user: { id: senderId, login: senderLogin, type: senderType },
    },
    repository: { full_name: overrides?.repo ?? "owner/repo" },
    installation: { id: overrides?.installationId ?? 12345 },
    sender: { id: senderId, login: senderLogin, type: senderType },
  };
}

describe("POST /api/webhooks/github", () => {
  beforeEach(() => {
    context.setupMocks();

    // Stub GitHub App env vars
    vi.stubEnv("GITHUB_APP_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
    vi.stubEnv("GITHUB_APP_SLUG", TEST_APP_SLUG);

    // Reload env after stubbing
    reloadEnv();

    // Mock GitHub API: installation token + issue comments (used by context fetching)
    server.use(
      http.post(
        "https://api.github.com/app/installations/:id/access_tokens",
        () => {
          return HttpResponse.json({
            token: "ghs_test",
            expires_at: "2099-01-01T00:00:00Z",
          });
        },
      ),
      http.get(
        "https://api.github.com/repos/:owner/:repo/issues/:num/comments",
        () => {
          return HttpResponse.json([]);
        },
      ),
    );
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
    it("should trigger agent for opened issue with app slug label", async () => {
      // Given a GitHub installation exists
      const { ghInstallationId, githubUserId, userId, orgId } =
        await givenGitHubInstallation();

      // When a webhook arrives for an opened issue with the app slug label
      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload({
          action: "opened",
          labels: [{ id: 1, name: TEST_APP_SLUG }],
          installationId: ghInstallationId,
          senderId: Number(githubUserId),
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      // Then a run should have been created
      const run = await findMostRecentRunForUser(userId, orgId);
      expect(run).toBeDefined();
      // Issue body and integration context are now in appendSystemPrompt
      expect(run?.appendSystemPrompt).toContain("This is a test issue body");
      expect(run?.appendSystemPrompt).toContain(
        "You are currently running inside: GitHub",
      );
      const callbacks = await findTestRunCallbacks(run!.id);
      expect(callbacks).toHaveLength(1);
      const payload = callbacks[0]!.payload as { issueNumber: number };
      expect(payload.issueNumber).toBe(42);
    });

    it("should trigger agent when app slug label is added", async () => {
      const { ghInstallationId, githubUserId, userId, orgId } =
        await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload({
          action: "labeled",
          labels: [{ id: 1, name: TEST_APP_SLUG }],
          label: { id: 1, name: TEST_APP_SLUG },
          installationId: ghInstallationId,
          senderId: Number(githubUserId),
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      const run = await findMostRecentRunForUser(userId, orgId);
      expect(run).toBeDefined();
    });

    it("should NOT trigger agent for opened issue without app slug label", async () => {
      const { ghInstallationId, githubUserId, userId, orgId } =
        await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload({
          action: "opened",
          labels: [{ id: 2, name: "bug" }],
          installationId: ghInstallationId,
          senderId: Number(githubUserId),
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      const run = await findMostRecentRunForUser(userId, orgId);
      expect(run).toBeUndefined();
    });

    it("should NOT trigger agent when a non-app slug label is added", async () => {
      const { ghInstallationId, githubUserId, userId, orgId } =
        await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload({
          action: "labeled",
          labels: [
            { id: 1, name: TEST_APP_SLUG },
            { id: 2, name: "enhancement" },
          ],
          label: { id: 2, name: "enhancement" },
          installationId: ghInstallationId,
          senderId: Number(githubUserId),
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      const run = await findMostRecentRunForUser(userId, orgId);
      expect(run).toBeUndefined();
    });

    it("should ignore closed/edited/other issue actions", async () => {
      const { ghInstallationId, githubUserId, userId, orgId } =
        await givenGitHubInstallation();

      for (const action of ["closed", "edited", "reopened", "deleted"]) {
        const request = createGitHubWebhookRequest(
          "issues",
          buildIssuesPayload({
            action,
            labels: [{ id: 1, name: TEST_APP_SLUG }],
            installationId: ghInstallationId,
            senderId: Number(githubUserId),
          }),
        );
        const response = await POST(request);
        expect(response.status).toBe(200);

        await context.mocks.flushAfter();
      }

      const run = await findMostRecentRunForUser(userId, orgId);
      expect(run).toBeUndefined();
    });

    it("should handle issue with null body", async () => {
      const { ghInstallationId, githubUserId, userId, orgId } =
        await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload({
          action: "opened",
          labels: [{ id: 1, name: TEST_APP_SLUG }],
          installationId: ghInstallationId,
          issueBody: null,
          senderId: Number(githubUserId),
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      // When body is null, falls back to issue title in appendSystemPrompt
      const run = await findMostRecentRunForUser(userId, orgId);
      expect(run).toBeDefined();
      expect(run?.appendSystemPrompt).toContain("Test Issue");
      expect(run?.appendSystemPrompt).toContain(
        "You are currently running inside: GitHub",
      );
    });
  });

  describe("Issue Comment Event", () => {
    it("should NOT trigger for comment on issue with app slug label but no mention", async () => {
      const { ghInstallationId, githubUserId, userId, orgId } =
        await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issue_comment",
        buildIssueCommentPayload({
          labels: [{ id: 1, name: TEST_APP_SLUG }],
          commentBody: "Can you help me fix this?",
          installationId: ghInstallationId,
          senderId: Number(githubUserId),
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      // Label alone should NOT trigger — bot mention is required
      const run = await findMostRecentRunForUser(userId, orgId);
      expect(run).toBeUndefined();
    });

    it("should trigger agent for comment mentioning @bot", async () => {
      const { ghInstallationId, githubUserId, userId, orgId } =
        await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issue_comment",
        buildIssueCommentPayload({
          labels: [], // No app slug label
          commentBody: `@${TEST_APP_SLUG}[bot] please review this`,
          installationId: ghInstallationId,
          senderId: Number(githubUserId),
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      const run = await findMostRecentRunForUser(userId, orgId);
      expect(run).toBeDefined();
    });

    it("should NOT trigger for comment without label or mention", async () => {
      const { ghInstallationId, githubUserId, userId, orgId } =
        await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issue_comment",
        buildIssueCommentPayload({
          labels: [{ id: 2, name: "bug" }],
          commentBody: "Just a regular comment",
          installationId: ghInstallationId,
          senderId: Number(githubUserId),
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      const run = await findMostRecentRunForUser(userId, orgId);
      expect(run).toBeUndefined();
    });

    it("should prevent self-triggering from bot comments", async () => {
      const { ghInstallationId, githubUserId, userId, orgId } =
        await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issue_comment",
        buildIssueCommentPayload({
          labels: [{ id: 1, name: TEST_APP_SLUG }],
          commentBody: "Here is the analysis...",
          senderType: "Bot",
          senderLogin: `${TEST_APP_SLUG}[bot]`,
          installationId: ghInstallationId,
          senderId: Number(githubUserId),
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      const run = await findMostRecentRunForUser(userId, orgId);
      expect(run).toBeUndefined();
    });

    it("should ignore non-created comment actions", async () => {
      const { ghInstallationId, githubUserId, userId, orgId } =
        await givenGitHubInstallation();

      for (const action of ["edited", "deleted"]) {
        const request = createGitHubWebhookRequest(
          "issue_comment",
          buildIssueCommentPayload({
            action,
            labels: [{ id: 1, name: TEST_APP_SLUG }],
            installationId: ghInstallationId,
            senderId: Number(githubUserId),
          }),
        );
        const response = await POST(request);
        expect(response.status).toBe(200);

        await context.mocks.flushAfter();
      }

      const run = await findMostRecentRunForUser(userId, orgId);
      expect(run).toBeUndefined();
    });
  });

  describe("Installation Not Found", () => {
    it("should handle missing installation without crashing", async () => {
      // Use an installation ID that doesn't exist in the database
      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload({
          installationId: 99999,
          labels: [{ id: 1, name: TEST_APP_SLUG }],
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // The error thrown in dispatchAgentRun is caught by the .catch() in route.ts
      await context.mocks.flushAfter();

      // No run should be created since the installation doesn't exist
      // (no userId/orgId available to query, so we just verify 200 response above)
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
      accountLogin?: string;
      senderId?: number;
    }) {
      return {
        action: overrides?.action ?? "created",
        installation: {
          id: overrides?.installationId ?? 99999,
          account: {
            id: overrides?.accountId ?? 55555,
            login: overrides?.accountLogin ?? "test-org",
            type: overrides?.accountType ?? "Organization",
          },
        },
        sender: {
          id: overrides?.senderId ?? 12345,
          login: "installer-user",
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
      await createTestOrg(uniqueId("gh-org"));
      const { composeId } = await createTestCompose("gh-webhook-agent");

      const targetId = String(Math.floor(Math.random() * 1_000_000_000));
      const ghInstallationId = Math.floor(Math.random() * 1_000_000_000);

      // Create a pending installation record
      await insertTestPendingGitHubInstallation(composeId, targetId);

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

      await context.mocks.flushAfter();

      // Verify the pending installation was activated
      const installations =
        await findTestGitHubInstallationsByTargetId(targetId);
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
      await context.mocks.flushAfter();
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

      await context.mocks.flushAfter();
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
      const { ghInstallationId, githubUserId, userId, orgId } =
        await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issue_comment",
        buildIssueCommentPayload({
          labels: [],
          commentBody: `@${TEST_APP_SLUG}[bot] Follow-up question`,
          installationId: ghInstallationId,
          senderId: Number(githubUserId),
        }),
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      // Verify a run was created
      const run = await findMostRecentRunForUser(userId, orgId);
      expect(run).toBeDefined();

      // Verify callback was stored with GitHub-specific context
      const callbacks = await findTestRunCallbacks(run!.id);
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0]!.url).toContain("/api/internal/callbacks/github");
      const payload = callbacks[0]!.payload as {
        repo: string;
        issueNumber: number;
      };
      expect(payload.repo).toBe("owner/repo");
      expect(payload.issueNumber).toBe(42);
    });
  });

  // Regression: handleIssuesEvent / handleIssueCommentEvent route through
  // createZeroRun, which registers a nested after() for Phase 2 dispatch.
  // If the route registers the outer after() with an already-started promise,
  // the nested after() is scheduled after the Next.js request context has
  // been finalized and Phase 2 dispatch never runs — runs remain Pending
  // forever. Asserting callback form ("fn") here guards that contract.
  describe("after() callback form (nested-after propagation)", () => {
    it("registers issues handler via callback form", async () => {
      const { ghInstallationId, githubUserId } =
        await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issues",
        buildIssuesPayload({
          action: "opened",
          labels: [{ id: 1, name: TEST_APP_SLUG }],
          installationId: ghInstallationId,
          senderId: Number(githubUserId),
        }),
      );
      await POST(request);

      expect(globalThis.nextAfterArgForms).toEqual(["fn"]);
    });

    it("registers issue_comment handler via callback form", async () => {
      const { ghInstallationId, githubUserId } =
        await givenGitHubInstallation();

      const request = createGitHubWebhookRequest(
        "issue_comment",
        buildIssueCommentPayload({
          labels: [],
          commentBody: `@${TEST_APP_SLUG}[bot] please review`,
          installationId: ghInstallationId,
          senderId: Number(githubUserId),
        }),
      );
      await POST(request);

      expect(globalThis.nextAfterArgForms).toEqual(["fn"]);
    });

    it("registers installation handler via callback form", async () => {
      const request = createGitHubWebhookRequest("installation", {
        action: "created",
        installation: {
          id: 88888,
          account: { id: 77777, login: "test-org", type: "Organization" },
        },
        sender: { id: 12345, login: "installer-user" },
      });
      await POST(request);

      expect(globalThis.nextAfterArgForms).toEqual(["fn"]);
    });
  });
});
