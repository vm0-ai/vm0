import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
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
 * Create a request with valid Slack signature headers for interactive payload
 */
function createSignedSlackRequest(body: string): Request {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createSlackSignature(testSigningSecret, timestamp, body);

  return new Request("http://localhost/api/slack/interactive", {
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
 * Build URL-encoded form body for interactive payload
 */
function buildInteractiveBody(payload: Record<string, unknown>): string {
  const params = new URLSearchParams({
    payload: JSON.stringify(payload),
  });
  return params.toString();
}

describe("POST /api/slack/interactive", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  afterEach(() => {
    server.resetHandlers();
  });

  describe("Request Validation", () => {
    it("returns 503 when Slack signing secret is not configured", async () => {
      vi.stubEnv("SLACK_SIGNING_SECRET", "");
      reloadEnv();

      const body = buildInteractiveBody({ type: "block_actions" });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.error).toBe("Slack integration is not configured");

      vi.stubEnv("SLACK_SIGNING_SECRET", testSigningSecret);
      reloadEnv();
    });

    it("returns 401 when signature is invalid", async () => {
      const body = buildInteractiveBody({ type: "block_actions" });
      const timestamp = Math.floor(Date.now() / 1000).toString();

      const request = new Request("http://localhost/api/slack/interactive", {
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

    it("returns 400 when payload is missing", async () => {
      const body = "other=value";
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Missing payload");
    });
  });

  describe("Block Actions", () => {
    it("returns 200 for block_actions type", async () => {
      const body = buildInteractiveBody({
        type: "block_actions",
        user: { id: "U123", username: "testuser", team_id: "T123" },
        team: { id: "T123", domain: "test" },
        actions: [],
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe("View Submission - Agent Add Modal", () => {
    it("returns error when agent is not selected", async () => {
      const body = buildInteractiveBody({
        type: "view_submission",
        user: { id: "U123", username: "testuser", team_id: "T123" },
        team: { id: "T123", domain: "test" },
        view: {
          id: "V123",
          callback_id: "agent_add_modal",
          state: {
            values: {
              agent_select: { agent_select_action: {} },
            },
          },
        },
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_action).toBe("errors");
      expect(data.errors.agent_select).toBe("Please select an agent");
    });

    it("returns error when user is not linked", async () => {
      // Create a compose first so we can reference it
      const { composeId } = await context.createSlackBinding(
        (await context.createSlackInstallation({ withUserLink: true })).userLink
          .id,
        { agentName: "temp-agent" },
      );

      const body = buildInteractiveBody({
        type: "view_submission",
        user: { id: "U-unlinked", username: "testuser", team_id: "T-test" },
        team: { id: "T-test", domain: "test" },
        view: {
          id: "V123",
          callback_id: "agent_add_modal",
          state: {
            values: {
              agent_select: {
                agent_select_action: { selected_option: { value: composeId } },
              },
            },
          },
        },
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.response_action).toBe("errors");
      expect(data.errors.agent_select).toContain("not linked");
    });
  });

  describe("Unknown Callback", () => {
    it("returns 200 for unknown callback_id", async () => {
      const body = buildInteractiveBody({
        type: "view_submission",
        user: { id: "U123", username: "testuser", team_id: "T123" },
        team: { id: "T123", domain: "test" },
        view: {
          id: "V123",
          callback_id: "unknown_modal",
          state: { values: {} },
        },
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });
});
