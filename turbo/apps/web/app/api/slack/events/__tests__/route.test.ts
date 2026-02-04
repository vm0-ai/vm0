import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { POST } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../src/env";
import { server } from "../../../../../src/mocks/server";

// Mock only external dependencies (third-party packages)
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

// Mock next/server's after() function which requires a request scope
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return {
    ...original,
    after: vi.fn(),
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
 * Create a request with valid Slack signature headers
 */
function createSignedSlackRequest(body: string): Request {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createSlackSignature(testSigningSecret, timestamp, body);

  return new Request("http://localhost/api/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body,
  });
}

describe("POST /api/slack/events", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  afterEach(() => {
    server.resetHandlers();
  });

  describe("Configuration", () => {
    it("returns 503 when Slack signing secret is not configured", async () => {
      // Temporarily clear signing secret to test unconfigured state
      vi.stubEnv("SLACK_SIGNING_SECRET", "");
      reloadEnv();

      const body = JSON.stringify({
        type: "url_verification",
        challenge: "test",
      });
      const request = createTestRequest(
        "http://localhost:3000/api/slack/events",
        {
          method: "POST",
          body,
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.error).toBe("Slack integration is not configured");

      // Restore the signing secret for subsequent tests
      vi.stubEnv("SLACK_SIGNING_SECRET", testSigningSecret);
      reloadEnv();
    });
  });

  describe("Signature Verification", () => {
    it("returns 401 when signature headers are missing", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/slack/events",
        {
          method: "POST",
          body: JSON.stringify({ type: "url_verification", challenge: "test" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe("Missing Slack signature headers");
    });

    it("returns 401 when signature is invalid", async () => {
      const body = JSON.stringify({
        type: "url_verification",
        challenge: "test",
      });
      const timestamp = Math.floor(Date.now() / 1000).toString();

      const request = new Request("http://localhost/api/slack/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
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

    it("returns 401 when timestamp is too old (replay attack protection)", async () => {
      const body = JSON.stringify({
        type: "url_verification",
        challenge: "test",
      });
      // Timestamp from 10 minutes ago
      const oldTimestamp = (Math.floor(Date.now() / 1000) - 600).toString();
      const signature = createSlackSignature(
        testSigningSecret,
        oldTimestamp,
        body,
      );

      const request = new Request("http://localhost/api/slack/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": oldTimestamp,
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
    it("returns 400 when JSON is invalid", async () => {
      const invalidBody = "invalid json";
      const request = createSignedSlackRequest(invalidBody);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Invalid JSON payload");
    });
  });

  describe("URL Verification", () => {
    it("handles URL verification challenge and returns challenge value", async () => {
      const challenge = "test-challenge-123";
      const body = JSON.stringify({
        type: "url_verification",
        challenge,
        token: "test-token",
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.challenge).toBe(challenge);
    });
  });

  describe("Event Handling", () => {
    it("returns 200 immediately for app_mention events", async () => {
      // Note: The actual async handler processing is tested separately
      // This test verifies the route responds quickly to meet Slack's 3-second requirement
      const body = JSON.stringify({
        type: "event_callback",
        token: "test-token",
        team_id: "T123",
        api_app_id: "A123",
        event: {
          type: "app_mention",
          user: "U123",
          text: "<@BXYZ> hello",
          ts: "1234567890.123456",
          channel: "C123",
          event_ts: "1234567890.123456",
        },
        event_id: "E123",
        event_time: 1234567890,
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toBe("OK");
    });

    it("returns 200 for app_mention events in a thread", async () => {
      const body = JSON.stringify({
        type: "event_callback",
        token: "test-token",
        team_id: "T123",
        api_app_id: "A123",
        event: {
          type: "app_mention",
          user: "U123",
          text: "<@BXYZ> follow up",
          ts: "1234567890.999999",
          channel: "C123",
          event_ts: "1234567890.999999",
          thread_ts: "1234567890.123456",
        },
        event_id: "E123",
        event_time: 1234567890,
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toBe("OK");
    });

    it("returns 200 for unknown event types", async () => {
      const body = JSON.stringify({
        type: "unknown_event_type",
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it("returns 200 for event_callback with unknown inner event type", async () => {
      const body = JSON.stringify({
        type: "event_callback",
        token: "test-token",
        team_id: "T123",
        api_app_id: "A123",
        event: {
          type: "message",
          user: "U123",
          text: "hello",
          ts: "1234567890.123456",
          channel: "C123",
        },
        event_id: "E123",
        event_time: 1234567890,
      });
      const request = createSignedSlackRequest(body);

      const response = await POST(request);
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toBe("OK");
    });
  });
});
