import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
  uniqueNumericId,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createSignedCallbackRequest,
  createTestAgentSession,
  createTestCallback,
  createTestCompose,
  createTestRequest,
  createAgentPhoneThreadSession,
  deleteTestAgentPhoneUserLinkById,
  findTestAgentPhoneThreadSession,
  findTestRunRecord,
  insertTestAgentPhoneUserLink,
  setTestRunSelectedModel,
} from "../../../../../../src/__tests__/api-test-helpers";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { http } from "../../../../../../src/__tests__/msw";
import { server } from "../../../../../../src/mocks/server";

const context = testContext();

const AGENTPHONE_AGENT_ID = "agt-callback-test";
const TEST_AGENTPHONE_NUMBER = "+19039853128";

function uniquePhone(): string {
  return `+1555${uniqueNumericId().slice(0, 7)}`;
}

interface AgentPhoneSendMessageBody {
  agent_id: string;
  to_number: string;
  body: string;
}

interface AgentPhoneTestPayload {
  messageId: string;
  conversationId: string | null;
  channel?: string;
  phoneHandle: string;
  fromNumber: string;
  toNumber: string;
  userLinkId: string;
  agentId: string;
  agentphoneAgentId: string;
  existingSessionId: string | null;
}

function agentPhoneSendMessage() {
  const calls: AgentPhoneSendMessageBody[] = [];
  const handler = http.post(
    "https://api.agentphone.to/v1/messages",
    async ({ request }) => {
      const body = (await request.json()) as AgentPhoneSendMessageBody;
      calls.push(body);
      return HttpResponse.json({
        id: uniqueId("sent"),
        status: "sent",
        channel: "sms",
        from_number: TEST_AGENTPHONE_NUMBER,
        to_number: body.to_number,
      });
    },
  );
  return { ...handler, calls };
}

function agentPhoneTypingIndicator() {
  const calls: Array<{ conversationId: string }> = [];
  const handler = http.post(
    "https://api.agentphone.to/v1/conversations/:conversationId/typing",
    ({ params }) => {
      calls.push({ conversationId: String(params.conversationId) });
      return HttpResponse.json({
        conversationId: params.conversationId,
        channel: "imessage",
        status: "sent",
      });
    },
  );
  return { ...handler, calls };
}

async function setupAgentPhoneCallback(): Promise<{
  composeId: string;
  userId: string;
  userLinkId: string;
  runId: string;
  payload: AgentPhoneTestPayload;
  secret: string;
}> {
  const phone = uniquePhone();
  const user = await context.setupUser();
  const { composeId } = await createTestCompose(uniqueId("agentphone-agent"));
  const link = await insertTestAgentPhoneUserLink({
    phoneHandle: phone,
    vm0UserId: user.userId,
    orgId: user.orgId,
  });
  const { runId } = await seedTestRun(user.userId, composeId, {
    prompt: "AgentPhone callback prompt",
  });

  const payload: AgentPhoneTestPayload = {
    messageId: "msg-callback-1",
    conversationId: "conv-callback-1",
    phoneHandle: phone,
    fromNumber: phone,
    toNumber: TEST_AGENTPHONE_NUMBER,
    userLinkId: link.id,
    agentId: composeId,
    agentphoneAgentId: AGENTPHONE_AGENT_ID,
    existingSessionId: null,
  };

  const { secret } = await createTestCallback({
    runId,
    url: "http://localhost/api/internal/callbacks/agentphone",
    payload: { ...payload },
  });

  return {
    composeId,
    userId: user.userId,
    userLinkId: link.id,
    runId,
    payload,
    secret,
  };
}

describe("POST /api/internal/callbacks/agentphone", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("rejects requests with invalid signatures", async () => {
    const { runId, payload, secret } = await setupAgentPhoneCallback();

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/agentphone",
      { runId, status: "completed", payload },
      secret,
      { invalidSignature: true },
    );
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("returns success for progress callbacks without sending a message", async () => {
    const { runId, payload, secret } = await setupAgentPhoneCallback();
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/agentphone",
      { runId, status: "progress", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(sendMessage.calls).toHaveLength(0);
  });

  it("refreshes iMessage typing on progress callbacks", async () => {
    const { runId, payload, secret } = await setupAgentPhoneCallback();
    const typing = agentPhoneTypingIndicator();
    server.use(typing.handler);

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/agentphone",
      {
        runId,
        status: "progress",
        payload: { ...payload, channel: "imessage" },
      },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(typing.mocked).toHaveBeenCalledTimes(1);
    expect(typing.calls[0]).toEqual({
      conversationId: payload.conversationId,
    });
  });

  it("sends completed run output through AgentPhone and stores the session", async () => {
    const { runId, payload, secret, userId, composeId, userLinkId } =
      await setupAgentPhoneCallback();
    await createTestAgentSession(userId, composeId);
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      { eventData: { result: "Done from AgentPhone." } },
    ]);
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/agentphone",
      { runId, status: "completed", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(sendMessage.calls).toEqual([
      expect.objectContaining({
        agent_id: AGENTPHONE_AGENT_ID,
        to_number: payload.phoneHandle,
        body: "Done from AgentPhone.",
      }),
    ]);

    const thread = await findTestAgentPhoneThreadSession({
      agentphoneUserLinkId: userLinkId,
    });
    expect(thread).toEqual(
      expect.objectContaining({
        conversationId: "conv-callback-1",
        lastProcessedMessageId: "msg-callback-1",
      }),
    );
  });

  it("does not warn SMS callback recipients on normal replies", async () => {
    const { runId, payload, secret } = await setupAgentPhoneCallback();
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      { eventData: { result: "Done from SMS AgentPhone." } },
    ]);
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/agentphone",
      {
        runId,
        status: "completed",
        payload: { ...payload, channel: "sms" },
      },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(sendMessage.calls[0]?.body).toContain("Done from SMS AgentPhone.");
    expect(sendMessage.calls[0]?.body).not.toContain(
      "SMS and MMS replies may not be delivered reliably",
    );
  });

  it("skips completed callbacks after the phone link is disconnected", async () => {
    const { runId, payload, secret, userLinkId } =
      await setupAgentPhoneCallback();
    await deleteTestAgentPhoneUserLinkById(userLinkId);
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      { eventData: { result: "Should not be delivered." } },
    ]);
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/agentphone",
      { runId, status: "completed", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(sendMessage.calls).toHaveLength(0);
  });

  it("adds a model footer to AgentPhone replies", async () => {
    const { runId, payload, secret } = await setupAgentPhoneCallback();
    await setTestRunSelectedModel(runId, "claude-opus-4-7");
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      { eventData: { result: "Done from AgentPhone." } },
    ]);
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/agentphone",
      { runId, status: "completed", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(sendMessage.calls[0]?.body).toBe(
      "Done from AgentPhone.\n\nClaude Opus 4.7",
    );
  });

  it("replaces an existing DM mapping when a new session was started", async () => {
    const { runId, payload, secret, userId, composeId, userLinkId } =
      await setupAgentPhoneCallback();
    const run = await findTestRunRecord(runId);
    const oldSession = await createTestAgentSession(userId, composeId);
    await createAgentPhoneThreadSession({
      agentphoneUserLinkId: userLinkId,
      agentSessionId: oldSession.id,
    });
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      { eventData: { result: "New session response." } },
    ]);
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/agentphone",
      {
        runId,
        status: "completed",
        payload: { ...payload, existingSessionId: null },
      },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    const thread = await findTestAgentPhoneThreadSession({
      agentphoneUserLinkId: userLinkId,
    });
    expect(thread?.agentSessionId).toBe(run?.sessionId);
    expect(thread?.agentSessionId).not.toBe(oldSession.id);
  });

  it("sends failed run errors through AgentPhone", async () => {
    const { runId, payload, secret } = await setupAgentPhoneCallback();
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/agentphone",
      {
        runId,
        status: "failed",
        error: "Agent crashed unexpectedly",
        payload,
      },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(sendMessage.calls[0]?.body).toContain("Agent crashed unexpectedly");
  });

  it("rejects callback requests with invalid payloads", async () => {
    const { runId, secret } = await setupAgentPhoneCallback();

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/agentphone",
      {
        runId,
        status: "completed",
        payload: { messageId: "missing-fields" },
      },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid or missing payload",
    });
  });

  it("rejects callback requests without a runId", async () => {
    const request = createTestRequest(
      "http://localhost/api/internal/callbacks/agentphone",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VM0-Signature": "any-signature",
          "X-VM0-Timestamp": Math.floor(Date.now() / 1000).toString(),
        },
        body: JSON.stringify({
          status: "completed",
          payload: {
            messageId: "msg-1",
            phoneHandle: uniquePhone(),
          },
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("runId");
  });
});
