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
  findTestIMessageThreadSession,
  insertTestIMessageUserLink,
} from "../../../../../../src/__tests__/api-test-helpers";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { http } from "../../../../../../src/__tests__/msw";
import { server } from "../../../../../../src/mocks/server";

const context = testContext();

const AGENTPHONE_AGENT_ID = "agt-callback-test";
const TEST_IMESSAGE_NUMBER = "+19039853128";

function uniquePhone(): string {
  return `+1555${uniqueNumericId().slice(0, 7)}`;
}

interface AgentPhoneSendMessageBody {
  agent_id: string;
  to_number: string;
  body: string;
}

interface IMessageTestPayload {
  messageId: string;
  conversationId: string | null;
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
        channel: "imessage",
        from_number: TEST_IMESSAGE_NUMBER,
        to_number: body.to_number,
      });
    },
  );
  return { ...handler, calls };
}

async function setupIMessageCallback(): Promise<{
  composeId: string;
  userId: string;
  userLinkId: string;
  runId: string;
  payload: IMessageTestPayload;
  secret: string;
}> {
  const phone = uniquePhone();
  const user = await context.setupUser();
  const { composeId } = await createTestCompose(uniqueId("imessage-agent"));
  const link = await insertTestIMessageUserLink({
    phoneHandle: phone,
    vm0UserId: user.userId,
    orgId: user.orgId,
  });
  const { runId } = await seedTestRun(user.userId, composeId, {
    prompt: "iMessage callback prompt",
  });

  const payload: IMessageTestPayload = {
    messageId: "msg-callback-1",
    conversationId: "conv-callback-1",
    phoneHandle: phone,
    fromNumber: phone,
    toNumber: TEST_IMESSAGE_NUMBER,
    userLinkId: link.id,
    agentId: composeId,
    agentphoneAgentId: AGENTPHONE_AGENT_ID,
    existingSessionId: null,
  };

  const { secret } = await createTestCallback({
    runId,
    url: "http://localhost/api/internal/callbacks/imessage",
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

describe("POST /api/internal/callbacks/imessage", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("rejects requests with invalid signatures", async () => {
    const { runId, payload, secret } = await setupIMessageCallback();

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/imessage",
      { runId, status: "completed", payload },
      secret,
      { invalidSignature: true },
    );
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("returns success for progress callbacks without sending a message", async () => {
    const { runId, payload, secret } = await setupIMessageCallback();
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/imessage",
      { runId, status: "progress", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(sendMessage.calls).toHaveLength(0);
  });

  it("sends completed run output through AgentPhone and stores the session", async () => {
    const { runId, payload, secret, userId, composeId, userLinkId } =
      await setupIMessageCallback();
    await createTestAgentSession(userId, composeId);
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      { eventData: { result: "Done from iMessage." } },
    ]);
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/imessage",
      { runId, status: "completed", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(sendMessage.calls).toEqual([
      expect.objectContaining({
        agent_id: AGENTPHONE_AGENT_ID,
        to_number: payload.phoneHandle,
        body: "Done from iMessage.",
      }),
    ]);

    const thread = await findTestIMessageThreadSession({
      imessageUserLinkId: userLinkId,
    });
    expect(thread).toEqual(
      expect.objectContaining({
        conversationId: "conv-callback-1",
        lastProcessedMessageId: "msg-callback-1",
      }),
    );
  });

  it("sends failed run errors through AgentPhone", async () => {
    const { runId, payload, secret } = await setupIMessageCallback();
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/imessage",
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
    const { runId, secret } = await setupIMessageCallback();

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/imessage",
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
      "http://localhost/api/internal/callbacks/imessage",
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
