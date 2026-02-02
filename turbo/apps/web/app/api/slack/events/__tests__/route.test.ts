import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "../route";

// Mock the handleAppMention function
vi.mock("../../../../../src/lib/slack/handlers/mention", () => ({
  handleAppMention: vi.fn().mockResolvedValue(undefined),
}));

// Mock the env function
vi.mock("../../../../../src/env", () => ({
  env: vi.fn().mockReturnValue({
    SLACK_SIGNING_SECRET: "test-signing-secret",
  }),
}));

// Mock the verify module
vi.mock("../../../../../src/lib/slack/verify", () => ({
  getSlackSignatureHeaders: vi.fn().mockReturnValue({
    signature: "v0=test-signature",
    timestamp: "1234567890",
  }),
  verifySlackSignature: vi.fn().mockReturnValue(true),
}));

// Mock initServices
vi.mock("../../../../../src/lib/init-services", () => ({
  initServices: vi.fn(),
}));

import { handleAppMention } from "../../../../../src/lib/slack/handlers/mention";
import {
  getSlackSignatureHeaders,
  verifySlackSignature,
} from "../../../../../src/lib/slack/verify";
import { env } from "../../../../../src/env";

describe("POST /api/slack/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 503 when Slack is not configured", async () => {
    vi.mocked(env).mockReturnValue({
      SLACK_SIGNING_SECRET: undefined,
    } as ReturnType<typeof env>);

    const request = new Request("http://localhost/api/slack/events", {
      method: "POST",
      body: JSON.stringify({ type: "url_verification", challenge: "test" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.error).toBe("Slack integration is not configured");
  });

  it("returns 401 when signature headers are missing", async () => {
    vi.mocked(env).mockReturnValue({
      SLACK_SIGNING_SECRET: "test-secret",
    } as ReturnType<typeof env>);
    vi.mocked(getSlackSignatureHeaders).mockReturnValue(null);

    const request = new Request("http://localhost/api/slack/events", {
      method: "POST",
      body: JSON.stringify({ type: "url_verification", challenge: "test" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Missing Slack signature headers");
  });

  it("returns 401 when signature is invalid", async () => {
    vi.mocked(env).mockReturnValue({
      SLACK_SIGNING_SECRET: "test-secret",
    } as ReturnType<typeof env>);
    vi.mocked(getSlackSignatureHeaders).mockReturnValue({
      signature: "v0=invalid",
      timestamp: "1234567890",
    });
    vi.mocked(verifySlackSignature).mockReturnValue(false);

    const request = new Request("http://localhost/api/slack/events", {
      method: "POST",
      body: JSON.stringify({ type: "url_verification", challenge: "test" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Invalid signature");
  });

  it("returns 400 when JSON is invalid", async () => {
    vi.mocked(env).mockReturnValue({
      SLACK_SIGNING_SECRET: "test-secret",
    } as ReturnType<typeof env>);
    vi.mocked(getSlackSignatureHeaders).mockReturnValue({
      signature: "v0=valid",
      timestamp: "1234567890",
    });
    vi.mocked(verifySlackSignature).mockReturnValue(true);

    const request = new Request("http://localhost/api/slack/events", {
      method: "POST",
      body: "invalid json",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Invalid JSON payload");
  });

  it("handles URL verification challenge", async () => {
    vi.mocked(env).mockReturnValue({
      SLACK_SIGNING_SECRET: "test-secret",
    } as ReturnType<typeof env>);
    vi.mocked(getSlackSignatureHeaders).mockReturnValue({
      signature: "v0=valid",
      timestamp: "1234567890",
    });
    vi.mocked(verifySlackSignature).mockReturnValue(true);

    const request = new Request("http://localhost/api/slack/events", {
      method: "POST",
      body: JSON.stringify({
        type: "url_verification",
        challenge: "test-challenge-123",
        token: "test-token",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.challenge).toBe("test-challenge-123");
  });

  it("handles app_mention event and returns 200 immediately", async () => {
    vi.mocked(env).mockReturnValue({
      SLACK_SIGNING_SECRET: "test-secret",
    } as ReturnType<typeof env>);
    vi.mocked(getSlackSignatureHeaders).mockReturnValue({
      signature: "v0=valid",
      timestamp: "1234567890",
    });
    vi.mocked(verifySlackSignature).mockReturnValue(true);

    const request = new Request("http://localhost/api/slack/events", {
      method: "POST",
      body: JSON.stringify({
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
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toBe("OK");

    // Give time for async handler to be called
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handleAppMention).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "C123",
      userId: "U123",
      messageText: "<@BXYZ> hello",
      messageTs: "1234567890.123456",
      threadTs: undefined,
    });
  });

  it("handles app_mention event in a thread", async () => {
    vi.mocked(env).mockReturnValue({
      SLACK_SIGNING_SECRET: "test-secret",
    } as ReturnType<typeof env>);
    vi.mocked(getSlackSignatureHeaders).mockReturnValue({
      signature: "v0=valid",
      timestamp: "1234567890",
    });
    vi.mocked(verifySlackSignature).mockReturnValue(true);

    const request = new Request("http://localhost/api/slack/events", {
      method: "POST",
      body: JSON.stringify({
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
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    // Give time for async handler to be called
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handleAppMention).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "C123",
      userId: "U123",
      messageText: "<@BXYZ> follow up",
      messageTs: "1234567890.999999",
      threadTs: "1234567890.123456",
    });
  });

  it("returns 200 for unknown event types", async () => {
    vi.mocked(env).mockReturnValue({
      SLACK_SIGNING_SECRET: "test-secret",
    } as ReturnType<typeof env>);
    vi.mocked(getSlackSignatureHeaders).mockReturnValue({
      signature: "v0=valid",
      timestamp: "1234567890",
    });
    vi.mocked(verifySlackSignature).mockReturnValue(true);

    const request = new Request("http://localhost/api/slack/events", {
      method: "POST",
      body: JSON.stringify({
        type: "unknown_event_type",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
  });
});
