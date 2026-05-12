import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import {
  testContext,
  uniqueId,
  uniqueNumericId,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestAgentSession,
  createIMessageThreadSession,
  countTestIMessageMessages,
  enableModelFirstModelProviderForUser,
  findTestIMessageUserLink,
  getOrgMembersEntry,
  imessageThreadSessionExists,
  insertOrgModelPolicy,
  findTestRunCallbacks,
  findTestRunsByUserAndPromptContaining,
  findTestZeroRun,
  insertTestIMessageUserLink,
  setDefaultAgentByComposeId,
} from "../../../../../../src/__tests__/api-test-helpers";
import { http } from "../../../../../../src/__tests__/msw";
import { server } from "../../../../../../src/mocks/server";
import {
  nextAfterArgForms,
  nextAfterCallbacks,
} from "../../../../../../src/__tests__/next-after-hooks";
import { POST } from "../route";

const context = testContext();
const WEBHOOK_SECRET = "test-agentphone-webhook-secret";
const AGENTPHONE_AGENT_ID = "agt-imessage-test";
const TEST_IMESSAGE_NUMBER = "+19039853128";

function uniquePhone(): string {
  return `+1555${uniqueNumericId().slice(0, 7)}`;
}

interface AgentPhoneSendMessageBody {
  agent_id: string;
  to_number: string;
  body: string;
}

function signAgentPhoneWebhook(rawBody: string, timestamp: number): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET)
    .update(`${String(timestamp)}.${rawBody}`)
    .digest("hex")}`;
}

function createWebhookPayload(overrides?: {
  channel?: string;
  event?: string;
  message?: string;
  messageId?: string;
  from?: string;
  to?: string;
  webhookId?: string;
}) {
  return {
    event: overrides?.event ?? "agent.message",
    channel: overrides?.channel ?? "imessage",
    timestamp: "2026-05-12T12:00:00Z",
    agentId: AGENTPHONE_AGENT_ID,
    data: {
      id: overrides?.messageId ?? uniqueId("msg"),
      conversationId: uniqueId("conv"),
      from: overrides?.from ?? uniquePhone(),
      to: overrides?.to ?? TEST_IMESSAGE_NUMBER,
      message: overrides?.message ?? "hello zero",
      mediaUrl: null,
      direction: "inbound",
      receivedAt: "2026-05-12T12:00:00Z",
    },
  };
}

function createWebhookRequest(
  payload: Record<string, unknown>,
  options?: {
    invalidSignature?: boolean;
    expiredTimestamp?: boolean;
    webhookId?: string;
  },
): Request {
  const timestamp = options?.expiredTimestamp
    ? Math.floor(Date.now() / 1000) - 600
    : Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify(payload);
  const signature = options?.invalidSignature
    ? "sha256=invalid"
    : signAgentPhoneWebhook(rawBody, timestamp);

  return new Request("http://localhost/api/agentphone/imessage/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Signature": signature,
      "X-Webhook-Timestamp": String(timestamp),
      "X-Webhook-ID": options?.webhookId ?? uniqueId("wh"),
    },
    body: rawBody,
  });
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
        channel: "imessage",
        from_number: TEST_IMESSAGE_NUMBER,
        to_number: body.to_number,
      });
    },
  );
  return { ...handler, calls };
}

describe("POST /api/agentphone/imessage/webhook", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("rejects invalid webhook signatures", async () => {
    const response = await POST(
      createWebhookRequest(createWebhookPayload(), { invalidSignature: true }),
    );

    expect(response.status).toBe(401);
  });

  it("rejects stale webhook timestamps", async () => {
    const response = await POST(
      createWebhookRequest(createWebhookPayload(), { expiredTimestamp: true }),
    );

    expect(response.status).toBe(401);
  });

  it("ignores non-iMessage message channels before scheduling a run", async () => {
    const response = await POST(
      createWebhookRequest(createWebhookPayload({ channel: "sms" })),
    );

    expect(response.status).toBe(200);
    expect(nextAfterCallbacks).toHaveLength(0);
    expect(nextAfterArgForms).toEqual([]);
  });

  it("sends a connect prompt for unlinked iMessage handles", async () => {
    const phone = uniquePhone();
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const response = await POST(
      createWebhookRequest(
        createWebhookPayload({ from: phone, message: "hello from iMessage" }),
      ),
    );

    expect(response.status).toBe(200);
    expect(nextAfterArgForms).toEqual(["fn"]);
    await context.mocks.flushAfter();

    expect(sendMessage.calls).toHaveLength(1);
    expect(sendMessage.calls[0]).toEqual(
      expect.objectContaining({
        agent_id: AGENTPHONE_AGENT_ID,
        to_number: phone,
      }),
    );
    expect(sendMessage.calls[0]?.body).toContain(
      "/api/agentphone/imessage/connect",
    );
    expect(await countTestIMessageMessages(phone)).toBe(1);
  });

  it("routes linked iMessage messages to Zero with imessage trigger metadata", async () => {
    const phone = uniquePhone();
    const messageId = uniqueId("msg-linked");
    const webhookId = uniqueId("wh-linked");
    const user = await context.setupUser();
    const { composeId } = await createTestCompose(uniqueId("imessage-agent"));
    await setDefaultAgentByComposeId(user.orgId, composeId);
    const link = await insertTestIMessageUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });

    const response = await POST(
      createWebhookRequest(
        createWebhookPayload({
          from: phone,
          message: "ship the iMessage report",
          messageId,
        }),
        { webhookId },
      ),
    );

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    const runs = await findTestRunsByUserAndPromptContaining(
      user.userId,
      "ship the iMessage report",
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.orgId).toBe(user.orgId);
    await expect(findTestZeroRun(runs[0]!.id)).resolves.toEqual(
      expect.objectContaining({ triggerSource: "imessage" }),
    );

    const callbacks = await findTestRunCallbacks(runs[0]!.id);
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.payload).toEqual(
      expect.objectContaining({
        messageId,
        phoneHandle: phone,
        fromNumber: phone,
        toNumber: TEST_IMESSAGE_NUMBER,
        userLinkId: link.id,
        agentId: composeId,
        agentphoneAgentId: AGENTPHONE_AGENT_ID,
        existingSessionId: null,
      }),
    );
  });

  it("deduplicates duplicate webhook deliveries", async () => {
    const phone = uniquePhone();
    const messageId = uniqueId("msg-dupe");
    const webhookId = uniqueId("wh-dupe");
    const user = await context.setupUser();
    const { composeId } = await createTestCompose(uniqueId("imessage-agent"));
    await setDefaultAgentByComposeId(user.orgId, composeId);
    await insertTestIMessageUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });

    const payload = createWebhookPayload({
      from: phone,
      message: "dedupe this imessage",
      messageId,
    });
    const first = await POST(createWebhookRequest(payload, { webhookId }));
    const second = await POST(createWebhookRequest(payload, { webhookId }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await context.mocks.flushAfter();

    const runs = await findTestRunsByUserAndPromptContaining(
      user.userId,
      "dedupe this imessage",
    );
    expect(runs).toHaveLength(1);
    expect(await countTestIMessageMessages(phone)).toBe(1);
  });

  it("disconnects a linked handle without creating a run", async () => {
    const phone = uniquePhone();
    const user = await context.setupUser();
    await insertTestIMessageUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const response = await POST(
      createWebhookRequest(
        createWebhookPayload({
          from: phone,
          message: "/disconnect",
          messageId: uniqueId("msg-disconnect"),
        }),
      ),
    );

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    expect(await findTestIMessageUserLink(phone)).toBeUndefined();
    const runs = await findTestRunsByUserAndPromptContaining(
      user.userId,
      "/disconnect",
    );
    expect(runs).toHaveLength(0);
    expect(sendMessage.calls[0]?.body).toContain("disconnected");
  });

  it("handles /help without creating a run", async () => {
    const phone = uniquePhone();
    const user = await context.setupUser();
    await insertTestIMessageUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const response = await POST(
      createWebhookRequest(
        createWebhookPayload({
          from: phone,
          message: "/help",
          messageId: uniqueId("msg-help"),
        }),
      ),
    );

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    expect(sendMessage.calls[0]?.body).toContain("/connect");
    const runs = await findTestRunsByUserAndPromptContaining(
      user.userId,
      "/help",
    );
    expect(runs).toHaveLength(0);
  });

  it("handles /model by updating the user's model preference", async () => {
    const phone = uniquePhone();
    const user = await context.setupUser();
    await insertTestIMessageUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    await enableModelFirstModelProviderForUser(user.orgId, user.userId);
    await insertOrgModelPolicy({
      orgId: user.orgId,
      model: "claude-sonnet-4-6",
      isDefault: true,
    });
    await insertOrgModelPolicy({
      orgId: user.orgId,
      model: "deepseek-v4-pro",
    });
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const response = await POST(
      createWebhookRequest(
        createWebhookPayload({
          from: phone,
          message: "/model deepseek-v4-pro",
          messageId: uniqueId("msg-model"),
        }),
      ),
    );

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    const saved = await getOrgMembersEntry(user.orgId, user.userId);
    expect(saved?.selectedModel).toBe("deepseek-v4-pro");
    expect(sendMessage.calls[0]?.body).toContain("Switched to DeepSeek V4 Pro");
  });

  it("handles /new_session by clearing the current iMessage session", async () => {
    const phone = uniquePhone();
    const user = await context.setupUser();
    const { composeId } = await createTestCompose(uniqueId("imessage-agent"));
    const link = await insertTestIMessageUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    const session = await createTestAgentSession(user.userId, composeId);
    await createIMessageThreadSession({
      imessageUserLinkId: link.id,
      agentSessionId: session.id,
      lastProcessedMessageId: "msg-before-reset",
    });
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const response = await POST(
      createWebhookRequest(
        createWebhookPayload({
          from: phone,
          message: "/new_session",
          messageId: uniqueId("msg-reset"),
        }),
      ),
    );

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    await expect(
      imessageThreadSessionExists({ imessageUserLinkId: link.id }),
    ).resolves.toBe(false);
    expect(sendMessage.calls[0]?.body).toContain("New session started");
  });
});
