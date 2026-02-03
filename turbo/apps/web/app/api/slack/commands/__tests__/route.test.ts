import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { http, HttpResponse } from "msw";
import { POST } from "../route";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../src/env";
import { server } from "../../../../../src/mocks/server";

// Mock only external dependencies (third-party packages)
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

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

  afterEach(() => {
    server.resetHandlers();
  });

  describe("Configuration", () => {
    it("returns 503 when Slack signing secret is not configured", async () => {
      vi.stubEnv("SLACK_SIGNING_SECRET", "");
      reloadEnv();

      const body = buildCommandBody("help", "T123", "U123");
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.error).toBe("Slack integration is not configured");

      vi.stubEnv("SLACK_SIGNING_SECRET", testSigningSecret);
      reloadEnv();
    });
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
      // Create installation first
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
      // Don't create installation - use a random workspace ID
      const body = buildCommandBody("agent list", "T-nonexistent", "U123");
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
      // Don't create user link

      const body = buildCommandBody(
        "agent list",
        installation.slackWorkspaceId,
        "U-unlinked",
      );
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_type).toBe("ephemeral");
      expect(data.blocks).toBeDefined();
      // Should contain login URL with oauth/install path
      const blockStr = JSON.stringify(data.blocks);
      expect(blockStr).toContain("oauth/install");
    });
  });

  describe("Agent List Command", () => {
    it("returns empty list when user has no agents", async () => {
      const { installation, userLink } = await context.createSlackInstallation({
        withUserLink: true,
      });

      const body = buildCommandBody(
        "agent list",
        installation.slackWorkspaceId,
        userLink.slackUserId,
      );
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_type).toBe("ephemeral");
      expect(data.blocks).toBeDefined();
    });

    it("returns list of bound agents", async () => {
      const { installation, userLink } = await context.createSlackInstallation({
        withUserLink: true,
      });
      await context.createSlackBinding(userLink.id, {
        agentName: "test-agent",
        description: "A test agent",
      });

      const body = buildCommandBody(
        "agent list",
        installation.slackWorkspaceId,
        userLink.slackUserId,
      );
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_type).toBe("ephemeral");
      const blockStr = JSON.stringify(data.blocks);
      expect(blockStr).toContain("test-agent");
    });
  });

  describe("Agent Remove Command", () => {
    it("returns error when user has no agents", async () => {
      const { installation, userLink } = await context.createSlackInstallation({
        withUserLink: true,
      });

      const body = buildCommandBody(
        "agent remove",
        installation.slackWorkspaceId,
        userLink.slackUserId,
      );
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_type).toBe("ephemeral");
      const blockStr = JSON.stringify(data.blocks);
      expect(blockStr).toContain("don't have any agents");
    });

    it("opens modal when user has agents", async () => {
      // Mock Slack views.open API
      server.use(
        http.post("https://slack.com/api/views.open", () => {
          return HttpResponse.json({ ok: true, view: { id: "V123" } });
        }),
      );

      const { installation, userLink } = await context.createSlackInstallation({
        withUserLink: true,
      });
      await context.createSlackBinding(userLink.id, { agentName: "to-remove" });

      const body = buildCommandBody(
        "agent remove",
        installation.slackWorkspaceId,
        userLink.slackUserId,
      );
      const request = createSignedSlackRequest(body);

      const response = await POST(request);

      // When opening a modal, Slack expects empty 200 response
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe("");
    });
  });

  describe("Unknown Commands", () => {
    it("returns error for unknown agent action", async () => {
      const { installation, userLink } = await context.createSlackInstallation({
        withUserLink: true,
      });

      const body = buildCommandBody(
        "agent unknown",
        installation.slackWorkspaceId,
        userLink.slackUserId,
      );
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_type).toBe("ephemeral");
      const blockStr = JSON.stringify(data.blocks);
      expect(blockStr).toContain("Unknown agent command");
    });

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
