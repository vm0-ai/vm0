/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { initServices } from "../../init-services";
import { apiKeys } from "../../../db/schema/api-key";
import { agentConfigs } from "../../../db/schema/agent-config";
import { agentRuntimes } from "../../../db/schema/agent-runtime";
import { agentRuntimeEvents } from "../../../db/schema/agent-runtime-event";
import { generateWebhookToken } from "../../webhook-auth";
import { eq } from "drizzle-orm";
import { POST } from "../../../../app/api/webhooks/agent-events/route";
import type { WebhookRequest, WebhookResponse } from "../../../types/webhook";

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

describe("POST /api/webhooks/agent-events", () => {
  const testApiKey = "test-api-key-123";
  let testApiKeyId: string;
  let testAgentConfigId: string;
  let testRuntimeId: string;

  beforeEach(async () => {
    initServices();

    // Clean up test data
    await globalThis.services.db.delete(agentRuntimeEvents).execute();
    await globalThis.services.db.delete(agentRuntimes).execute();
    await globalThis.services.db.delete(agentConfigs).execute();
    await globalThis.services.db
      .delete(apiKeys)
      .where(eq(apiKeys.name, "Test API Key"))
      .execute();

    // Create test API key
    const [insertedKey] = await globalThis.services.db
      .insert(apiKeys)
      .values({
        keyHash: hashApiKey(testApiKey),
        name: "Test API Key",
      })
      .returning({ id: apiKeys.id });

    testApiKeyId = insertedKey?.id ?? "";

    // Create test agent config
    const [insertedConfig] = await globalThis.services.db
      .insert(agentConfigs)
      .values({
        apiKeyId: testApiKeyId,
        config: {
          version: "1.0",
          agent: {
            description: "Test agent",
            image: "test",
            provider: "claude-code",
            working_dir: "/workspace",
            volumes: [],
          },
        },
      })
      .returning({ id: agentConfigs.id });

    testAgentConfigId = insertedConfig?.id ?? "";

    // Create test runtime
    const [insertedRuntime] = await globalThis.services.db
      .insert(agentRuntimes)
      .values({
        agentConfigId: testAgentConfigId,
        status: "running",
        prompt: "test prompt",
      })
      .returning({ id: agentRuntimes.id });

    testRuntimeId = insertedRuntime?.id ?? "";
  });

  afterEach(async () => {
    // Clean up test data
    await globalThis.services.db.delete(agentRuntimeEvents).execute();
    await globalThis.services.db.delete(agentRuntimes).execute();
    await globalThis.services.db.delete(agentConfigs).execute();
    await globalThis.services.db
      .delete(apiKeys)
      .where(eq(apiKeys.name, "Test API Key"))
      .execute();
  });

  it("should store events from webhook", async () => {
    // Generate webhook token
    const token = generateWebhookToken(testRuntimeId);

    // Create webhook request
    const body: WebhookRequest = {
      runtimeId: testRuntimeId,
      events: [
        {
          type: "init",
          timestamp: Date.now(),
          sessionId: "ses-123",
          data: { cwd: "/workspace", tools: ["bash", "read"] },
        },
        {
          type: "text",
          timestamp: Date.now(),
          sessionId: "ses-123",
          data: { content: "Hello from agent" },
        },
      ],
    };

    const request = new NextRequest(
      "http://localhost/api/webhooks/agent-events",
      {
        method: "POST",
        headers: {
          "X-Vm0-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    // Call the webhook endpoint
    const response = await POST(request);
    expect(response.status).toBe(200);

    const data: WebhookResponse = await response.json();
    expect(data.received).toBe(2);
    expect(data.firstSequence).toBe(1);
    expect(data.lastSequence).toBe(2);

    // Verify events in database
    const events = await globalThis.services.db
      .select()
      .from(agentRuntimeEvents)
      .where(eq(agentRuntimeEvents.runtimeId, testRuntimeId));

    expect(events).toHaveLength(2);
    expect(events[0]?.eventType).toBe("init");
    expect(events[0]?.sequenceNumber).toBe(1);
    expect(events[1]?.eventType).toBe("text");
    expect(events[1]?.sequenceNumber).toBe(2);
  });

  it("should reject invalid token", async () => {
    const body: WebhookRequest = {
      runtimeId: testRuntimeId,
      events: [
        {
          type: "test",
          timestamp: Date.now(),
          data: {},
        },
      ],
    };

    const request = new NextRequest(
      "http://localhost/api/webhooks/agent-events",
      {
        method: "POST",
        headers: {
          "X-Vm0-Token": "invalid-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error.message).toBe("Invalid webhook token");
  });

  it("should reject missing token", async () => {
    const body: WebhookRequest = {
      runtimeId: testRuntimeId,
      events: [
        {
          type: "test",
          timestamp: Date.now(),
          data: {},
        },
      ],
    };

    const request = new NextRequest(
      "http://localhost/api/webhooks/agent-events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error.message).toBe("Missing webhook token");
  });

  it("should handle multiple batches correctly", async () => {
    const token = generateWebhookToken(testRuntimeId);

    // Send first batch
    const body1: WebhookRequest = {
      runtimeId: testRuntimeId,
      events: [
        { type: "init", timestamp: Date.now(), data: {} },
        { type: "text", timestamp: Date.now(), data: {} },
      ],
    };

    const request1 = new NextRequest(
      "http://localhost/api/webhooks/agent-events",
      {
        method: "POST",
        headers: {
          "X-Vm0-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body1),
      },
    );

    const response1 = await POST(request1);
    expect(response1.status).toBe(200);

    const data1: WebhookResponse = await response1.json();
    expect(data1.firstSequence).toBe(1);
    expect(data1.lastSequence).toBe(2);

    // Send second batch
    const body2: WebhookRequest = {
      runtimeId: testRuntimeId,
      events: [
        { type: "tool_use", timestamp: Date.now(), data: {} },
        { type: "result", timestamp: Date.now(), data: {} },
      ],
    };

    const request2 = new NextRequest(
      "http://localhost/api/webhooks/agent-events",
      {
        method: "POST",
        headers: {
          "X-Vm0-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body2),
      },
    );

    const response2 = await POST(request2);
    expect(response2.status).toBe(200);

    const data2: WebhookResponse = await response2.json();
    expect(data2.firstSequence).toBe(3);
    expect(data2.lastSequence).toBe(4);

    // Verify all 4 events in database
    const events = await globalThis.services.db
      .select()
      .from(agentRuntimeEvents)
      .where(eq(agentRuntimeEvents.runtimeId, testRuntimeId));

    expect(events).toHaveLength(4);
  });

  it("should reject empty events array", async () => {
    const token = generateWebhookToken(testRuntimeId);

    const body: WebhookRequest = {
      runtimeId: testRuntimeId,
      events: [],
    };

    const request = new NextRequest(
      "http://localhost/api/webhooks/agent-events",
      {
        method: "POST",
        headers: {
          "X-Vm0-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error.message).toBe("Events array cannot be empty");
  });

  it("should reject missing runtimeId", async () => {
    const token = "rt-test-123-abc";

    const body = {
      events: [{ type: "test", timestamp: Date.now(), data: {} }],
    };

    const request = new NextRequest(
      "http://localhost/api/webhooks/agent-events",
      {
        method: "POST",
        headers: {
          "X-Vm0-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error.message).toBe("Missing runtimeId");
  });

  it("should reject non-existent runtime", async () => {
    const nonExistentRuntimeId = "00000000-0000-0000-0000-000000000000";
    const token = generateWebhookToken(nonExistentRuntimeId);

    const body: WebhookRequest = {
      runtimeId: nonExistentRuntimeId,
      events: [{ type: "test", timestamp: Date.now(), data: {} }],
    };

    const request = new NextRequest(
      "http://localhost/api/webhooks/agent-events",
      {
        method: "POST",
        headers: {
          "X-Vm0-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error.message).toBe("Agent runtime not found");
  });
});
