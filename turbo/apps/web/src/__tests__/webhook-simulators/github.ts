import crypto from "crypto";
import { env } from "../../env";
import { POST } from "../../../app/api/webhooks/github/route";

/**
 * GitHub Webhook Simulator
 *
 * Simulates GitHub webhook events using real HMAC-SHA256 signing.
 * No mocking needed — just sign the payload with GITHUB_APP_WEBHOOK_SECRET.
 *
 * Consumer test files MUST stub env vars in beforeEach:
 *
 *   vi.stubEnv("GITHUB_APP_WEBHOOK_SECRET", "test-secret");
 *   vi.stubEnv("GITHUB_APP_SLUG", "vm0-bot");
 *   reloadEnv();
 */

function signPayload(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function createGitHubWebhookRequest(
  event: string,
  payload: Record<string, unknown>,
): Request {
  const body = JSON.stringify(payload);
  const secret = env().GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "GITHUB_APP_WEBHOOK_SECRET must be stubbed via vi.stubEnv() before using GitHub simulators",
    );
  }
  const signature = signPayload(body, secret);
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-event": event,
      "x-github-delivery": crypto.randomUUID(),
    },
    body,
  });
}

export async function simulateGitHubInstallation(
  installationId: number,
  targetId: number,
  action: string,
  sender?: { id: number; login: string },
): Promise<Response> {
  const payload = {
    action,
    installation: {
      id: installationId,
      account: { id: targetId, login: "test-org", type: "Organization" },
    },
    sender: sender ?? { id: 12345, login: "installer-user" },
  };
  return POST(createGitHubWebhookRequest("installation", payload));
}

export async function simulateGitHubIssueOpened(
  installationId: number,
  issueData: {
    number: number;
    title: string;
    body?: string;
    labels?: Array<{ id: number; name: string }>;
  },
): Promise<Response> {
  const payload = {
    action: "opened",
    issue: {
      number: issueData.number,
      title: issueData.title,
      body: issueData.body ?? "Test issue body",
      labels: issueData.labels ?? [],
      user: { id: 100, login: "testuser", type: "User" },
    },
    repository: { full_name: "owner/repo" },
    installation: { id: installationId },
    sender: { id: 100, login: "testuser", type: "User" },
  };
  return POST(createGitHubWebhookRequest("issues", payload));
}
