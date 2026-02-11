import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "crypto";
import { WebClient } from "@slack/web-api";
import { POST } from "../route";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { givenLinkedSlackUser } from "../../../../../src/__tests__/slack/api-helpers";

// Mock only external dependencies (third-party packages)

// Mock Next.js after() to run promises without deferring
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return {
    ...original,
    after: (promise: Promise<unknown>) => {
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

  describe("Signature Verification", () => {
    it("returns 401 when signature headers are missing", async () => {
      const body = buildInteractiveBody({ type: "block_actions" });
      const request = new Request("http://localhost/api/slack/interactive", {
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
  });

  describe("Payload Parsing", () => {
    it("returns 400 when payload is missing", async () => {
      const body = "other=value";
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Missing payload");
    });

    it("returns 400 when payload is invalid JSON", async () => {
      const params = new URLSearchParams({ payload: "not-json" });
      const body = params.toString();
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Invalid payload");
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

  describe("Block Actions - Home Tab", () => {
    it("acknowledges home_environment_setup click (button opens Platform URL directly)", async () => {
      const { userLink, installation } = await givenLinkedSlackUser();

      const body = buildInteractiveBody({
        type: "block_actions",
        user: {
          id: userLink.slackUserId,
          username: "testuser",
          team_id: installation.slackWorkspaceId,
        },
        team: { id: installation.slackWorkspaceId, domain: "test" },
        trigger_id: "trigger-456",
        actions: [
          {
            action_id: "home_environment_setup",
            block_id: "block-1",
          },
        ],
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it("disconnects user and refreshes home when home_disconnect is clicked", async () => {
      const { userLink, installation } = await givenLinkedSlackUser();

      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.views.publish.mockClear();

      const body = buildInteractiveBody({
        type: "block_actions",
        user: {
          id: userLink.slackUserId,
          username: "testuser",
          team_id: installation.slackWorkspaceId,
        },
        team: { id: installation.slackWorkspaceId, domain: "test" },
        actions: [{ action_id: "home_disconnect", block_id: "block-1" }],
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);

      expect(response.status).toBe(200);
      // App Home was refreshed after disconnect
      expect(mockClient.views.publish).toHaveBeenCalled();
    });
  });

  describe("Unknown Callback", () => {
    it("returns 200 for unknown view_submission", async () => {
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
