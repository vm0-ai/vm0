import { after } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { handleAgentPhoneMessage } from "../../../../src/lib/zero/agentphone/handlers/inbound";
import {
  normalizePhoneHandle,
  resolveAgentPhoneUserLink,
  storeInboundAgentPhoneMessage,
  type AgentPhoneMessageEvent,
} from "../../../../src/lib/zero/agentphone/shared";
import { verifyAgentPhoneWebhook } from "../../../../src/lib/zero/agentphone/verify";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("agentphone:webhook");

const webhookBodySchema = z.record(z.string(), z.unknown());
const supportedAgentPhoneMessageChannels = new Set(["imessage", "sms", "mms"]);

function valueObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractAgentPhoneEvent(
  body: Record<string, unknown>,
  webhookId: string | null,
  channel: string,
): AgentPhoneMessageEvent | null {
  const data = valueObject(body.data);
  const messageId =
    stringValue(data, ["messageId", "id"]) ??
    stringValue(body, ["messageId", "id"]) ??
    webhookId;
  const agentphoneAgentId =
    stringValue(body, ["agentId", "agent_id"]) ??
    stringValue(data, ["agentId", "agent_id"]);
  const fromNumber = stringValue(data, ["from", "fromNumber", "from_number"]);
  const toNumber = stringValue(data, ["to", "toNumber", "to_number"]);
  const messageBody =
    stringValue(data, ["message", "body", "text"]) ??
    stringValue(body, ["message", "body", "text"]) ??
    "";
  const mediaUrl =
    stringValue(data, ["mediaUrl", "media_url"]) ??
    stringValue(body, ["mediaUrl", "media_url"]) ??
    null;
  const conversationId =
    stringValue(data, ["conversationId", "conversation_id"]) ??
    stringValue(body, ["conversationId", "conversation_id"]) ??
    null;

  if (!messageId || !agentphoneAgentId || !fromNumber || !toNumber) {
    log.warn("Missing required fields in AgentPhone webhook", {
      webhookId,
      hasMessageId: Boolean(messageId),
      hasAgentId: Boolean(agentphoneAgentId),
      hasFromNumber: Boolean(fromNumber),
      hasToNumber: Boolean(toNumber),
      bodyKeys: Object.keys(body),
      dataKeys: Object.keys(data),
    });
    return null;
  }

  return {
    webhookId,
    channel,
    messageId,
    conversationId,
    agentphoneAgentId,
    fromNumber,
    toNumber,
    body: messageBody,
    mediaUrl,
    receivedAt:
      parseDate(data.receivedAt) ??
      parseDate(data.received_at) ??
      parseDate(body.timestamp),
  };
}

export async function POST(request: Request): Promise<Response> {
  const apiStartTime = Date.now();
  initServices();

  const { AGENTPHONE_PHONE_NUMBER, AGENTPHONE_WEBHOOK_SECRET } = env();
  if (!AGENTPHONE_WEBHOOK_SECRET || !AGENTPHONE_PHONE_NUMBER) {
    return new Response("Not Found", { status: 404 });
  }

  const rawBody = await request.text();
  if (
    !verifyAgentPhoneWebhook({
      rawBody,
      signature: request.headers.get("x-webhook-signature"),
      timestamp: request.headers.get("x-webhook-timestamp"),
      secret: AGENTPHONE_WEBHOOK_SECRET,
    })
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  let jsonBody: unknown;
  try {
    jsonBody = JSON.parse(rawBody) as unknown;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const parsed = webhookBodySchema.safeParse(jsonBody);
  if (!parsed.success) {
    return new Response("Bad Request", { status: 400 });
  }

  const body = parsed.data;
  const eventType =
    stringValue(body, ["event"]) ?? request.headers.get("x-webhook-event");
  if (eventType !== "agent.message") {
    return new Response("OK", { status: 200 });
  }

  const data = valueObject(body.data);
  const channel = (
    stringValue(body, ["channel"]) ??
    stringValue(data, ["channel"]) ??
    ""
  ).toLowerCase();
  if (!supportedAgentPhoneMessageChannels.has(channel)) {
    return new Response("OK", { status: 200 });
  }

  const webhookId = request.headers.get("x-webhook-id");
  const event = extractAgentPhoneEvent(body, webhookId, channel);
  if (!event) {
    return new Response("OK", { status: 200 });
  }

  if (
    normalizePhoneHandle(event.toNumber) !==
    normalizePhoneHandle(AGENTPHONE_PHONE_NUMBER)
  ) {
    return new Response("OK", { status: 200 });
  }

  const userLink = await resolveAgentPhoneUserLink(event.fromNumber);
  const stored = await storeInboundAgentPhoneMessage({
    event,
    userLinkId: userLink?.id ?? null,
  });
  if (!stored.inserted) {
    return new Response("OK", { status: 200 });
  }

  after(() => {
    return handleAgentPhoneMessage(event, userLink, apiStartTime).catch(
      (error) => {
        log.error("Error handling AgentPhone webhook", { error });
      },
    );
  });

  return new Response("OK", { status: 200 });
}
