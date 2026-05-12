import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { POST } from "../route";
import {
  createTestRequest,
  insertOrgMembersCacheEntry,
  insertTestAgentPhoneMessage,
  insertTestAgentPhoneUserLink,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  uniqueNumericId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../../../src/lib/auth/sandbox-token";
import { server } from "../../../../../../../src/mocks/server";

const URL = "http://localhost:3000/api/zero/integrations/phone/message";
const AGENTPHONE_AGENT_ID = "agt-phone-message-route";

const context = testContext();

function uniquePhone(): string {
  return `+1555${uniqueNumericId().slice(0, 7)}`;
}

describe("POST /api/zero/integrations/phone/message", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  async function zeroToken(): Promise<string> {
    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    return generateZeroToken(user.userId, "run-1", user.orgId);
  }

  function messageRequest(body: unknown, token?: string) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    return createTestRequest(URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when no auth token is provided", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      messageRequest({ toNumber: "+15551234567", text: "hello" }),
    );

    expect(response.status).toBe(401);
  });

  it("sends an AgentPhone message to a connected handle", async () => {
    const token = await zeroToken();
    const phone = uniquePhone();
    const link = await insertTestAgentPhoneUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    await insertTestAgentPhoneMessage({
      agentphoneMessageId: uniqueId("apmsg-inbound"),
      agentphoneAgentId: AGENTPHONE_AGENT_ID,
      agentphoneUserLinkId: link.id,
      phoneHandle: phone,
      fromNumber: phone,
      toNumber: "+19039853128",
      direction: "inbound",
      body: "hello",
    });

    let agentPhoneBody: Record<string, unknown> | undefined;
    server.use(
      http.post(
        "https://api.agentphone.to/v1/messages",
        async ({ request }) => {
          agentPhoneBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            id: "apmsg-outbound",
            status: "sent",
            channel: "sms",
            from_number: "+19039853128",
            to_number: phone,
          });
        },
      ),
    );

    const response = await POST(
      messageRequest({ toNumber: phone, text: "reply" }, token),
    );

    expect(response.status).toBe(200);
    expect(agentPhoneBody).toMatchObject({
      agent_id: AGENTPHONE_AGENT_ID,
      to_number: phone,
      body: "reply",
    });
    await expect(response.json()).resolves.toEqual({
      ok: true,
      messageId: "apmsg-outbound",
      channel: "sms",
      toNumber: phone,
    });
  });

  it("does not send to an unlinked handle", async () => {
    const token = await zeroToken();

    const response = await POST(
      messageRequest({ toNumber: uniquePhone(), text: "reply" }, token),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
