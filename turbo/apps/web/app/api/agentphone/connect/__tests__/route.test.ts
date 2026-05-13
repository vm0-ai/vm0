import { describe, expect, it } from "vitest";
import { HttpResponse } from "msw";
import {
  findTestAgentPhoneUserLink,
  insertTestAgentPhoneUserLink,
  signTestAgentPhoneConnectParams,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  uniqueNumericId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { http } from "../../../../../src/__tests__/msw";
import { server } from "../../../../../src/mocks/server";
import {
  mockAblyChannelsGet,
  mockAblyPublish,
} from "../../../../../src/__tests__/ably-mock";
import { POST } from "../route";

const context = testContext();
const AGENTPHONE_AGENT_ID = "agt-agentphone-connect-test";
const SECRETS_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

interface AgentPhoneSendMessageBody {
  agent_id: string;
  to_number: string;
  body: string;
}

function createConnectRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/agentphone/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createConnectBody(phoneHandle: string) {
  const { sig, ts } = signTestAgentPhoneConnectParams(
    phoneHandle,
    AGENTPHONE_AGENT_ID,
    SECRETS_ENCRYPTION_KEY,
  );
  return {
    phoneHandle,
    agentphoneAgentId: AGENTPHONE_AGENT_ID,
    timestamp: ts,
    signature: sig,
  };
}

function uniquePhone(): string {
  return `+1555${uniqueNumericId().slice(0, 7)}`;
}

function agentPhoneSendMessage() {
  const calls: AgentPhoneSendMessageBody[] = [];
  const handler = http.post(
    "https://api.agentphone.to/v1/messages",
    async ({ request }) => {
      const body = (await request.json()) as AgentPhoneSendMessageBody;
      calls.push(body);
      return HttpResponse.json({
        id: uniqueId("apmsg"),
        status: "sent",
        channel: "sms",
        from_number: "+19039853128",
        to_number: body.to_number,
      });
    },
  );
  return { ...handler, calls };
}

describe("POST /api/agentphone/connect", () => {
  it("requires authentication", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createConnectRequest(createConnectBody("+1702")),
    );

    expect(response.status).toBe(401);
  });

  it("links the signed phone handle to the authenticated user", async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const phone = uniquePhone();
    const sendMessage = agentPhoneSendMessage();
    mockAblyChannelsGet.mockClear();
    mockAblyPublish.mockClear();
    server.use(sendMessage.handler);

    const response = await POST(createConnectRequest(createConnectBody(phone)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ phoneHandle: phone });
    await expect(findTestAgentPhoneUserLink(phone)).resolves.toEqual(
      expect.objectContaining({
        phoneHandle: phone,
        vm0UserId: user.userId,
        orgId: user.orgId,
      }),
    );
    expect(sendMessage.calls).toHaveLength(1);
    expect(sendMessage.calls[0]).toEqual(
      expect.objectContaining({
        agent_id: AGENTPHONE_AGENT_ID,
        to_number: phone,
      }),
    );
    expect(mockAblyChannelsGet).toHaveBeenCalledWith(`user:${user.userId}`);
    expect(mockAblyPublish).toHaveBeenCalledWith("agentphone:changed", null);
  });

  it("normalizes phone handles before linking", async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const suffix = uniqueNumericId().slice(0, 4);
    const phone = `(555) 555-${suffix}`;
    const normalizedPhone = `555555${suffix}`;
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const response = await POST(createConnectRequest(createConnectBody(phone)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      phoneHandle: normalizedPhone,
    });
    await expect(findTestAgentPhoneUserLink(normalizedPhone)).resolves.toEqual(
      expect.objectContaining({
        phoneHandle: normalizedPhone,
        vm0UserId: user.userId,
        orgId: user.orgId,
      }),
    );
  });

  it("rejects phone handles already connected to another account", async () => {
    context.setupMocks();
    await context.setupUser();
    const phone = uniquePhone();
    await insertTestAgentPhoneUserLink({
      phoneHandle: phone,
      vm0UserId: uniqueId("existing-user"),
      orgId: uniqueId("existing-org"),
    });

    const response = await POST(createConnectRequest(createConnectBody(phone)));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: expect.objectContaining({ code: "CONFLICT" }),
    });
  });

  it("rejects a second phone handle for the same user and org", async () => {
    context.setupMocks();
    const user = await context.setupUser();
    await insertTestAgentPhoneUserLink({
      phoneHandle: uniquePhone(),
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    const nextPhone = uniquePhone();

    const response = await POST(
      createConnectRequest(createConnectBody(nextPhone)),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: expect.objectContaining({ code: "CONFLICT" }),
    });
    await expect(
      findTestAgentPhoneUserLink(nextPhone),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid signatures", async () => {
    context.setupMocks();
    await context.setupUser();
    const phone = uniquePhone();

    const response = await POST(
      createConnectRequest({
        ...createConnectBody(phone),
        signature: "bad-signature",
      }),
    );

    expect(response.status).toBe(400);
    await expect(findTestAgentPhoneUserLink(phone)).resolves.toBeUndefined();
  });
});
