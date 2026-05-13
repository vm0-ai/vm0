import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import {
  testContext,
  uniqueId,
  uniqueNumericId,
} from "../../../../../src/__tests__/test-helpers";
import {
  completeTestRun,
  createTestCompose,
  createTestAgentSession,
  createAgentPhoneThreadSession,
  countTestAgentPhoneMessages,
  findTestAgentPhoneUserLink,
  getOrgMembersEntry,
  agentphoneThreadSessionExists,
  insertOrgModelPolicy,
  insertTestAgentPhoneMessage,
  insertUserModelPreference,
  findTestRunCallbacks,
  findTestRunsByUserAndPromptContaining,
  findTestZeroRun,
  insertTestAgentPhoneUserLink,
  setOrgCredits,
  setDefaultAgentByComposeId,
  setTestRunModelProvider,
  setTestRunSelectedModel,
} from "../../../../../src/__tests__/api-test-helpers";
import { seedTestRun } from "../../../../../src/__tests__/db-test-seeders/runs";
import { http } from "../../../../../src/__tests__/msw";
import { server } from "../../../../../src/mocks/server";
import {
  nextAfterArgForms,
  nextAfterCallbacks,
} from "../../../../../src/__tests__/next-after-hooks";
import { env } from "../../../../../src/env";
import { POST } from "../route";

const context = testContext();
const AGENTPHONE_AGENT_ID = "agt-agentphone-test";
const TEST_AGENTPHONE_NUMBER = "+19039853128";

function uniquePhone(): string {
  return `+1555${uniqueNumericId().slice(0, 7)}`;
}

interface AgentPhoneSendMessageBody {
  agent_id: string;
  to_number: string;
  body: string;
}

function signAgentPhoneWebhook(rawBody: string, timestamp: number): string {
  const webhookSecret = env().AGENTPHONE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("AGENTPHONE_WEBHOOK_SECRET missing");

  return `sha256=${createHmac("sha256", webhookSecret)
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
    channel: overrides?.channel ?? "sms",
    timestamp: "2026-05-12T12:00:00Z",
    agentId: AGENTPHONE_AGENT_ID,
    data: {
      id: overrides?.messageId ?? uniqueId("msg"),
      conversationId: uniqueId("conv"),
      from: overrides?.from ?? uniquePhone(),
      to: overrides?.to ?? TEST_AGENTPHONE_NUMBER,
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

  return new Request("http://localhost/api/agentphone/webhook", {
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

describe("POST /api/agentphone/webhook", () => {
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

  it("ignores unsupported message channels before scheduling a run", async () => {
    const response = await POST(
      createWebhookRequest(createWebhookPayload({ channel: "voice" })),
    );

    expect(response.status).toBe(200);
    expect(nextAfterCallbacks).toHaveLength(0);
    expect(nextAfterArgForms).toEqual([]);
  });

  it("sends a connect prompt for unlinked SMS handles", async () => {
    const phone = uniquePhone();
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const response = await POST(
      createWebhookRequest(
        createWebhookPayload({
          channel: "sms",
          from: phone,
          message: "hello from SMS",
        }),
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
    expect(sendMessage.calls[0]?.body).toContain("/agentphone/connect");
    expect(sendMessage.calls[0]?.body).toContain("channel=sms");
    expect(sendMessage.calls[0]?.body).not.toContain(
      "SMS and MMS replies may not be delivered reliably",
    );
    expect(await countTestAgentPhoneMessages(phone)).toBe(1);
  });

  it("sends a connect prompt for unlinked MMS handles", async () => {
    const phone = uniquePhone();
    const sendMessage = agentPhoneSendMessage();
    server.use(sendMessage.handler);

    const response = await POST(
      createWebhookRequest(
        createWebhookPayload({
          channel: "mms",
          from: phone,
          message: "hello from MMS",
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(nextAfterArgForms).toEqual(["fn"]);
    await context.mocks.flushAfter();

    expect(sendMessage.calls).toHaveLength(1);
    expect(sendMessage.calls[0]?.body).toContain("/agentphone/connect");
    expect(sendMessage.calls[0]?.body).toContain("channel=mms");
    expect(sendMessage.calls[0]?.body).not.toContain(
      "SMS and MMS replies may not be delivered reliably",
    );
    expect(await countTestAgentPhoneMessages(phone)).toBe(1);
  });

  it("routes linked AgentPhone messages to Zero with agentphone trigger metadata", async () => {
    const phone = uniquePhone();
    const messageId = uniqueId("msg-linked");
    const webhookId = uniqueId("wh-linked");
    const user = await context.setupUser();
    const { composeId } = await createTestCompose(uniqueId("agentphone-agent"));
    await setDefaultAgentByComposeId(user.orgId, composeId);
    const link = await insertTestAgentPhoneUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    await insertTestAgentPhoneMessage({
      agentphoneMessageId: uniqueId("previous-msg"),
      phoneHandle: phone,
      fromNumber: phone,
      toNumber: TEST_AGENTPHONE_NUMBER,
      direction: "inbound",
      body: "previous owner secret",
    });
    const typing = agentPhoneTypingIndicator();
    server.use(typing.handler);

    const response = await POST(
      createWebhookRequest(
        createWebhookPayload({
          channel: "imessage",
          from: phone,
          message: "ship the AgentPhone report",
          messageId,
        }),
        { webhookId },
      ),
    );

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    const runs = await findTestRunsByUserAndPromptContaining(
      user.userId,
      "ship the AgentPhone report",
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.orgId).toBe(user.orgId);
    const zeroRun = await findTestZeroRun(runs[0]!.id);
    expect(zeroRun).toEqual(
      expect.objectContaining({ triggerSource: "agentphone" }),
    );
    expect(runs[0]?.appendSystemPrompt).not.toContain("previous owner secret");

    const callbacks = await findTestRunCallbacks(runs[0]!.id);
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.payload).toEqual(
      expect.objectContaining({
        messageId,
        channel: "imessage",
        phoneHandle: phone,
        fromNumber: phone,
        toNumber: TEST_AGENTPHONE_NUMBER,
        userLinkId: link.id,
        agentId: composeId,
        agentphoneAgentId: AGENTPHONE_AGENT_ID,
        existingSessionId: null,
      }),
    );
    expect(typing.mocked).toHaveBeenCalledTimes(1);
  });

  it("deduplicates duplicate webhook deliveries", async () => {
    const phone = uniquePhone();
    const messageId = uniqueId("msg-dupe");
    const webhookId = uniqueId("wh-dupe");
    const user = await context.setupUser();
    const { composeId } = await createTestCompose(uniqueId("agentphone-agent"));
    await setDefaultAgentByComposeId(user.orgId, composeId);
    await insertTestAgentPhoneUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });

    const payload = createWebhookPayload({
      from: phone,
      message: "dedupe this agentphone",
      messageId,
    });
    const first = await POST(createWebhookRequest(payload, { webhookId }));
    const second = await POST(createWebhookRequest(payload, { webhookId }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await context.mocks.flushAfter();

    const runs = await findTestRunsByUserAndPromptContaining(
      user.userId,
      "dedupe this agentphone",
    );
    expect(runs).toHaveLength(1);
    expect(await countTestAgentPhoneMessages(phone)).toBe(1);
  });

  it("disconnects a linked handle without creating a run", async () => {
    const phone = uniquePhone();
    const user = await context.setupUser();
    await insertTestAgentPhoneUserLink({
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

    expect(await findTestAgentPhoneUserLink(phone)).toBeUndefined();
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
    await insertTestAgentPhoneUserLink({
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
    expect(sendMessage.calls[0]?.body).toContain(
      "SMS and MMS replies may not be delivered reliably",
    );
    const runs = await findTestRunsByUserAndPromptContaining(
      user.userId,
      "/help",
    );
    expect(runs).toHaveLength(0);
  });

  it("handles /model by updating the user's model preference", async () => {
    const phone = uniquePhone();
    const user = await context.setupUser();
    await insertTestAgentPhoneUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
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

  it("starts a new AgentPhone session when the selected model changed", async () => {
    const phone = uniquePhone();
    const user = await context.setupUser();
    await setOrgCredits(user.orgId, 100_000);
    const { composeId } = await createTestCompose(uniqueId("agentphone-agent"));
    await setDefaultAgentByComposeId(user.orgId, composeId);
    await insertOrgModelPolicy({
      orgId: user.orgId,
      model: "claude-sonnet-4-6",
      isDefault: true,
    });
    await insertOrgModelPolicy({
      orgId: user.orgId,
      model: "claude-opus-4-7",
    });
    await insertUserModelPreference({
      orgId: user.orgId,
      userId: user.userId,
      model: "claude-opus-4-7",
    });

    const previous = await seedTestRun(user.userId, composeId, {
      prompt: "previous agentphone model session",
      triggerSource: "agentphone",
    });
    const { agentSessionId } = await completeTestRun(
      user.userId,
      previous.runId,
    );
    await setTestRunModelProvider(previous.runId, "vm0");
    await setTestRunSelectedModel(previous.runId, "claude-sonnet-4-6");

    const link = await insertTestAgentPhoneUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    await createAgentPhoneThreadSession({
      agentphoneUserLinkId: link.id,
      agentSessionId,
      lastProcessedMessageId: uniqueId("msg-before-model-change"),
    });

    const prompt = `model changed ${uniqueId("agentphone")}`;
    const response = await POST(
      createWebhookRequest(
        createWebhookPayload({
          from: phone,
          message: prompt,
          messageId: uniqueId("msg-model-change"),
        }),
      ),
    );

    expect(response.status).toBe(200);
    await context.mocks.flushAfter();

    const runs = await findTestRunsByUserAndPromptContaining(
      user.userId,
      prompt,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.continuedFromSessionId).toBeNull();
    expect(runs[0]?.sessionId).not.toBe(agentSessionId);
    await expect(findTestZeroRun(runs[0]!.id)).resolves.toEqual(
      expect.objectContaining({
        triggerSource: "agentphone",
        selectedModel: "claude-opus-4-7",
      }),
    );

    const callbacks = await findTestRunCallbacks(runs[0]!.id);
    expect(callbacks[0]?.payload).toEqual(
      expect.objectContaining({
        userLinkId: link.id,
        existingSessionId: null,
      }),
    );
  });

  it("handles /new_session by clearing the current AgentPhone session", async () => {
    const phone = uniquePhone();
    const user = await context.setupUser();
    const { composeId } = await createTestCompose(uniqueId("agentphone-agent"));
    const link = await insertTestAgentPhoneUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    const session = await createTestAgentSession(user.userId, composeId);
    await createAgentPhoneThreadSession({
      agentphoneUserLinkId: link.id,
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
      agentphoneThreadSessionExists({ agentphoneUserLinkId: link.id }),
    ).resolves.toBe(false);
    expect(sendMessage.calls[0]?.body).toContain("New session started");
  });
});
