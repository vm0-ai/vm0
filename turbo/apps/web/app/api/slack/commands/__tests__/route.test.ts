import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "crypto";
import { POST } from "../route";
import { testContext } from "../../../../../src/__tests__/test-helpers";

// Mock only external dependencies (third-party packages)

// Mock Next.js after() to capture promises instead of deferring
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return {
    ...original,
    after: (promise: Promise<unknown>) => {
      // Let the promise run but don't block
      promise.catch(() => {});
    },
  };
});

const context = testContext();

// Use the same signing secret as configured in setup.ts
const testSigningSecret = "test-slack-signing-secret";

/**
 * Create a valid Slack signature for testing
 */
function createSlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
): string {
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", signingSecret);
  return `v0=${hmac.update(baseString).digest("hex")}`;
}

/**
 * Create a request with valid Slack signature headers for URL-encoded form data
 */
function createSignedSlackRequest(body: string): Request {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createSlackSignature(testSigningSecret, timestamp, body);

  return new Request("http://localhost/api/slack/commands", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body,
  });
}

/**
 * Build URL-encoded form body for slash command
 */
function buildCommandBody(
  text: string,
  workspaceId: string,
  userId: string,
): string {
  const params = new URLSearchParams({
    token: "test-token",
    team_id: workspaceId,
    team_domain: "test-workspace",
    channel_id: "C123",
    channel_name: "general",
    user_id: userId,
    user_name: "testuser",
    command: "/vm0",
    text,
    response_url: "https://hooks.slack.com/commands/test",
    trigger_id: "trigger123",
    api_app_id: "A123",
  });
  return params.toString();
}

describe("POST /api/slack/commands", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("Signature Verification", () => {
    it("returns 401 when signature headers are missing", async () => {
      const body = buildCommandBody("help", "T123", "U123");
      const request = new Request("http://localhost/api/slack/commands", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe("Missing Slack signature headers");
    });

    it("returns 401 when signature is invalid", async () => {
      const body = buildCommandBody("help", "T123", "U123");
      const timestamp = Math.floor(Date.now() / 1000).toString();

      const request = new Request("http://localhost/api/slack/commands", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-slack-signature": "v0=invalid-signature",
          "x-slack-request-timestamp": timestamp,
        },
        body,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe("Invalid signature");
    });
  });

  describe("Help Command", () => {
    it("returns help message for empty command", async () => {
      const { installation } = await context.createSlackInstallation();

      const body = buildCommandBody("", installation.slackWorkspaceId, "U123");
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_type).toBe("ephemeral");
      expect(data.blocks).toBeDefined();
    });

    it("returns help message for 'help' command", async () => {
      const { installation } = await context.createSlackInstallation();

      const body = buildCommandBody(
        "help",
        installation.slackWorkspaceId,
        "U123",
      );
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_type).toBe("ephemeral");
      expect(data.blocks).toBeDefined();
    });
  });

  describe("Workspace Validation", () => {
    it("returns login prompt when workspace is not installed", async () => {
      const body = buildCommandBody("settings", "T-nonexistent", "U123");
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_type).toBe("ephemeral");
      // Should contain login URL with oauth/install path
      const blockStr = JSON.stringify(data.blocks);
      expect(blockStr).toContain("oauth/install");
    });
  });

  describe("User Link Validation", () => {
    it("returns login prompt when user is not linked", async () => {
      const { installation } = await context.createSlackInstallation();

      const body = buildCommandBody(
        "settings",
        installation.slackWorkspaceId,
        "U-unlinked",
      );
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_type).toBe("ephemeral");
      expect(data.blocks).toBeDefined();
      const blockStr = JSON.stringify(data.blocks);
      expect(blockStr).toContain("oauth/install");
    });
  });

  describe("Settings Command", () => {
    it("returns platform link for settings command", async () => {
      const { installation, userLink } = await context.createSlackInstallation({
        withUserLink: true,
      });

      const body = buildCommandBody(
        "settings",
        installation.slackWorkspaceId,
        userLink.slackUserId,
      );
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_type).toBe("ephemeral");
      const blockStr = JSON.stringify(data.blocks);
      expect(blockStr).toContain("Settings");
      expect(blockStr).toContain("/settings/slack");
    });
  });

  describe("Connect Command", () => {
    it("returns platform /slack/connect URL when workspace installed but user not linked", async () => {
      const { installation } = await context.createSlackInstallation();

      const body = buildCommandBody(
        "connect",
        installation.slackWorkspaceId,
        "U-new-user",
      );
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_type).toBe("ephemeral");
      const blockStr = JSON.stringify(data.blocks);
      // Should redirect to platform /slack/connect, not the old /slack/link
      expect(blockStr).toContain("/slack/connect");
      expect(blockStr).toContain(
        `w=${encodeURIComponent(installation.slackWorkspaceId)}`,
      );
      expect(blockStr).toContain("u=U-new-user");
      expect(blockStr).toContain("c=C123");
    });

    it("returns OAuth install URL when workspace not installed", async () => {
      const body = buildCommandBody("connect", "T-uninstalled", "U123");
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_type).toBe("ephemeral");
      const blockStr = JSON.stringify(data.blocks);
      expect(blockStr).toContain("oauth/install");
    });

    it("returns already-connected message when user is linked", async () => {
      const { installation, userLink } = await context.createSlackInstallation({
        withUserLink: true,
      });

      const body = buildCommandBody(
        "connect",
        installation.slackWorkspaceId,
        userLink.slackUserId,
      );
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_type).toBe("ephemeral");
      const blockStr = JSON.stringify(data.blocks);
      expect(blockStr).toContain("already connected");
    });
  });

  describe("Unknown Commands", () => {
    it("returns help message for unknown top-level command", async () => {
      const { installation, userLink } = await context.createSlackInstallation({
        withUserLink: true,
      });

      const body = buildCommandBody(
        "unknown",
        installation.slackWorkspaceId,
        userLink.slackUserId,
      );
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_type).toBe("ephemeral");
      // Returns help message for unknown commands
      expect(data.blocks).toBeDefined();
    });
  });
});
