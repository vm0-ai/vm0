import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createPhoneOrg,
  linkPhoneNumber,
  insertPendingOutboundCall,
} from "../../../../../../src/__tests__/db-test-seeders/phone";
import { findPendingOutboundCall } from "../../../../../../src/__tests__/db-test-assertions/phone";
import {
  insertOrgDefaultModelProvider,
  findMostRecentRunForUser,
} from "../../../../../../src/__tests__/api-test-helpers";

vi.mock("@clerk/nextjs/server");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

// Mock next/server after() to capture callbacks for flushing
const afterPromises: Promise<unknown>[] = [];
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return {
    ...original,
    after: (promise: Promise<unknown>) => {
      afterPromises.push(promise);
    },
  };
});

async function flushAfterCallbacks() {
  await Promise.allSettled(afterPromises);
  afterPromises.length = 0;
}

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
    afterPromises.length = 0;
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

  it("should accept well-formed call_ended events and dispatch after() callback", async () => {
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
    // after() callback was registered
    expect(afterPromises.length).toBe(1);
    // Handler runs without throwing (org not found — returns early gracefully)
    await flushAfterCallbacks();
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
    expect(afterPromises.length).toBe(1);
    await flushAfterCallbacks();
  });

  it("should dispatch run when org and linked user are found", async () => {
    const TEST_FROM_NUMBER = "+14155557890";

    // Set up org in DB with agentphoneAgentId and default agent, then link user phone
    const user = await context.setupUser();
    const { agentphoneAgentId } = await createPhoneOrg(user.orgId);
    await linkPhoneNumber(TEST_FROM_NUMBER, user.userId, user.orgId);

    // Set up a non-VM0 model provider so the pre-flight check passes without
    // requiring real API credentials or a runner in the test environment
    await insertOrgDefaultModelProvider(user.orgId, "anthropic");

    const request = createWebhookRequest({
      event: "agent.call_ended",
      channel: "voice",
      agentId: agentphoneAgentId,
      data: {
        conversationId: "conv_test",
        from: TEST_FROM_NUMBER,
        to: "+18001234567",
        direction: "inbound",
        durationSeconds: 60,
        transcript: [{ role: "user", content: "Hello" }],
        summary: "Brief test call.",
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(afterPromises.length).toBe(1);
    await flushAfterCallbacks();

    // Verify an agent_runs record was created for the user/org — this confirms
    // handleCallEnded resolved the org, found the linked user, and dispatched a run
    const run = await findMostRecentRunForUser(user.userId, user.orgId);

    expect(run).toBeDefined();
    expect(run!.userId).toBe(user.userId);
    expect(run!.orgId).toBe(user.orgId);
  });

  it("should dispatch follow-up run for fire-and-forget outbound call", async () => {
    const CALL_ID = uniqueId("call-outbound-ff");

    // Set up org and agent
    const user = await context.setupUser();
    const { composeId } = await createPhoneOrg(user.orgId);
    await insertOrgDefaultModelProvider(user.orgId, "anthropic");

    // Pre-register the pending outbound call (as if fire-and-forget POST already ran)
    await insertPendingOutboundCall({
      callId: CALL_ID,
      orgId: user.orgId,
      userId: user.userId,
      agentId: composeId,
    });

    // Simulate the AgentPhone call_ended webhook for an outbound call
    const request = createWebhookRequest({
      event: "agent.call_ended",
      channel: "voice",
      agentId: "ap-agent-irrelevant-for-outbound",
      data: {
        conversationId: CALL_ID,
        from: "+16067551512",
        to: "+14155551234",
        direction: "outbound",
        durationSeconds: 45,
        transcript: [
          { role: "agent", content: "Hello, this is a follow-up call." },
          { role: "user", content: "Yes, I remember." },
        ],
        summary: "Outbound follow-up call completed.",
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(afterPromises.length).toBe(1);
    await flushAfterCallbacks();

    // Verify the pending row was consumed (deleted)
    const remaining = await findPendingOutboundCall(CALL_ID);
    expect(remaining).toBeUndefined();

    // Verify a follow-up run was dispatched
    const run = await findMostRecentRunForUser(user.userId, user.orgId);
    expect(run).toBeDefined();
    expect(run!.userId).toBe(user.userId);
    expect(run!.orgId).toBe(user.orgId);
    expect(run!.prompt).toContain("outbound call to +14155551234");
  });
});
