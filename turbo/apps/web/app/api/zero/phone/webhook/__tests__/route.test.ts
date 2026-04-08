import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";

vi.mock("@clerk/nextjs/server");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

// Mock next/server after() to capture callbacks
vi.mock("next/server", async () => {
  const actual =
    await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (promise: Promise<unknown>) => {
      globalThis.nextAfterCallbacks.push(() => {
        return promise;
      });
    },
  };
});

import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";

const context = testContext();

function createWebhookRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/zero/phone/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/zero/phone/webhook", () => {
  beforeEach(async () => {
    context.setupMocks();
  });

  it("should reject invalid JSON body", async () => {
    const request = new Request(
      "http://localhost:3000/api/zero/phone/webhook",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  it("should accept and ignore non-call_ended events", async () => {
    const request = createWebhookRequest({
      event: "call_started",
      channel: "voice",
      agentId: "agent_123",
      data: {
        callId: "call_abc",
        from: "+14155551234",
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("OK");
  });

  it("should return 200 for call_ended event with missing required fields", async () => {
    // Missing agentId and from number - should still return 200 (webhook ack)
    const request = createWebhookRequest({
      event: "call_ended",
      data: {},
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
  });

  it("should accept well-formed call_ended events", async () => {
    const request = createWebhookRequest({
      event: "call_ended",
      channel: "voice",
      agentId: "agent_123",
      data: {
        callId: "call_abc",
        from: "+14155551234",
        to: "+18001234567",
        direction: "inbound",
        durationSeconds: 120,
        transcript: [
          { role: "agent", content: "Hello, how can I help?" },
          { role: "user", content: "I have a question." },
        ],
        summary: "User asked a question.",
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
  });

  it("should handle agent.call_ended event type", async () => {
    const request = createWebhookRequest({
      event: "agent.call_ended",
      channel: "voice",
      agentId: "agent_456",
      data: {
        conversationId: "conv_xyz",
        from: "+14155559999",
        to: "+18007654321",
        direction: "inbound",
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
  });
});
