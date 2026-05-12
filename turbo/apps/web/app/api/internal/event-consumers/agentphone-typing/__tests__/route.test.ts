import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { POST } from "../route";
import {
  createTestCallback,
  createTestCompose,
  createSignedCallbackRequest,
  insertTestAgentPhoneUserLink,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  uniqueNumericId,
} from "../../../../../../src/__tests__/test-helpers";
import { server } from "../../../../../../src/mocks/server";
import { http } from "../../../../../../src/__tests__/msw";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";

const SECRETS_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CONSUMER_URL =
  "http://localhost:3000/api/internal/event-consumers/agentphone-typing";
const AGENTPHONE_AGENT_ID = "agt-agentphone-typing-test";

const context = testContext();

function uniquePhone(): string {
  return `+1555${uniqueNumericId().slice(0, 7)}`;
}

function signed(body: unknown) {
  return createSignedCallbackRequest(
    CONSUMER_URL,
    body,
    SECRETS_ENCRYPTION_KEY,
  );
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

describe("POST /api/internal/event-consumers/agentphone-typing", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("rejects invalid signatures", async () => {
    const request = createSignedCallbackRequest(
      CONSUMER_URL,
      { runId: "r", events: [], context: {} },
      "wrong-key",
    );
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("refreshes typing for pending iMessage AgentPhone callbacks", async () => {
    const user = await context.setupUser();
    const { composeId } = await createTestCompose(uniqueId("ap-typing"));
    const phone = uniquePhone();
    const link = await insertTestAgentPhoneUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    const { runId } = await seedTestRun(user.userId, composeId);

    await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/agentphone",
      payload: {
        messageId: "msg-1",
        conversationId: "conv-agentphone-typing",
        channel: "imessage",
        phoneHandle: phone,
        fromNumber: phone,
        toNumber: "+19039853128",
        userLinkId: link.id,
        agentId: composeId,
        agentphoneAgentId: AGENTPHONE_AGENT_ID,
        existingSessionId: null,
      },
    });

    const typing = agentPhoneTypingIndicator();
    server.use(typing.handler);

    const response = await POST(
      signed({
        runId,
        events: [{ type: "assistant", sequenceNumber: 1 }],
        context: { userId: user.userId, orgId: user.orgId },
      }),
    );
    await context.mocks.flushAfter();

    expect(response.status).toBe(200);
    expect(typing.mocked).toHaveBeenCalledTimes(1);
    expect(typing.calls[0]).toEqual({
      conversationId: "conv-agentphone-typing",
    });
  });

  it("does nothing for SMS AgentPhone callbacks", async () => {
    const user = await context.setupUser();
    const { composeId } = await createTestCompose(uniqueId("ap-typing-none"));
    const phone = uniquePhone();
    const link = await insertTestAgentPhoneUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    const { runId } = await seedTestRun(user.userId, composeId);

    await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/agentphone",
      payload: {
        messageId: "msg-1",
        conversationId: "conv-agentphone-sms",
        channel: "sms",
        phoneHandle: phone,
        fromNumber: phone,
        toNumber: "+19039853128",
        userLinkId: link.id,
        agentId: composeId,
        agentphoneAgentId: AGENTPHONE_AGENT_ID,
        existingSessionId: null,
      },
    });

    const typing = agentPhoneTypingIndicator();
    server.use(typing.handler);

    const response = await POST(
      signed({
        runId,
        events: [{ type: "tool_result", sequenceNumber: 1 }],
        context: { userId: user.userId, orgId: user.orgId },
      }),
    );
    await context.mocks.flushAfter();

    expect(response.status).toBe(200);
    expect(typing.mocked).not.toHaveBeenCalled();
  });
});
