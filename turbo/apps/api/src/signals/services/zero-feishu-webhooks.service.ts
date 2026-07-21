import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { feishuAppCredentials } from "@vm0/db/schema/feishu-app-credential";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import { logger } from "../../lib/log";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { writeDb$ } from "../external/db";
import { now, nowDate } from "../external/time";
import { safeJsonParse, safeSync, tapError } from "../utils";
import { encryptPersistentSecretValue } from "./crypto.utils";
import { feishuConfig, type FeishuConfig } from "./feishu-config";
import {
  dispatchFeishuMessage$,
  type FeishuInboundMessage,
} from "./zero-feishu-dispatch.service";

const L = logger("ZeroFeishuWebhooks");

const encryptedBodySchema = z.object({ encrypt: z.string() });
const challengeSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string(),
  token: z.string(),
});
const v2EnvelopeSchema = z.object({
  schema: z.literal("2.0"),
  header: z.object({
    event_id: z.string(),
    event_type: z.string(),
    tenant_key: z.string(),
    app_id: z.string(),
    token: z.string(),
  }),
  event: z.unknown(),
});
const v2MessageEventSchema = z.object({
  sender: z.object({
    sender_id: z.object({ open_id: z.string() }),
    sender_type: z.string().optional(),
  }),
  message: z.object({
    message_id: z.string(),
    chat_id: z.string(),
    chat_type: z.string(),
    message_type: z.string(),
    content: z.string(),
  }),
});
const textContentSchema = z.object({ text: z.string() });
const legacyEventSchema = z
  .object({
    type: z.literal("event_callback"),
    token: z.string(),
    event: z
      .object({
        type: z.string(),
        app_id: z.string(),
        tenant_key: z.string().optional(),
        app_ticket: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const FEISHU_REPLAY_WINDOW_SECONDS = 60 * 5;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text: string): Response {
  return new Response(text, { status: 200 });
}

function verifySignature(args: {
  readonly rawBody: string;
  readonly timestamp: string | undefined;
  readonly nonce: string | undefined;
  readonly signature: string | undefined;
  readonly encryptKey: string;
}): boolean {
  if (!args.timestamp || !args.nonce || !args.signature) {
    return false;
  }
  const requestTime = Number(args.timestamp);
  const currentTime = Math.floor(now() / 1000);
  if (
    !Number.isSafeInteger(requestTime) ||
    Math.abs(currentTime - requestTime) > FEISHU_REPLAY_WINDOW_SECONDS
  ) {
    return false;
  }
  const expected = Buffer.from(
    createHash("sha256")
      .update(`${args.timestamp}${args.nonce}${args.encryptKey}${args.rawBody}`)
      .digest("hex"),
    "utf8",
  );
  const actual = Buffer.from(args.signature, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function decryptPayload(encrypted: string, encryptKey: string): unknown {
  const key = createHash("sha256").update(encryptKey).digest();
  const payload = Buffer.from(encrypted, "base64");
  if (payload.length <= 16) {
    throw new Error("Invalid encrypted Feishu payload");
  }
  const decipher = createDecipheriv(
    "aes-256-cbc",
    key,
    payload.subarray(0, 16),
  );
  const decrypted = Buffer.concat([
    decipher.update(payload.subarray(16)),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(decrypted) as unknown;
}

function parseBody(rawBody: string, config: FeishuConfig): unknown {
  const parsed = JSON.parse(rawBody) as unknown;
  const encrypted = encryptedBodySchema.safeParse(parsed);
  return encrypted.success
    ? decryptPayload(encrypted.data.encrypt, config.encryptKey)
    : parsed;
}

function validAppAndToken(
  appId: string | undefined,
  token: string,
  config: FeishuConfig,
): boolean {
  return (
    token === config.verificationToken && (!appId || appId === config.appId)
  );
}

const storeAppTicket$ = command(
  async (
    { set },
    args: { readonly appId: string; readonly appTicket: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const encryptedAppTicket = await encryptPersistentSecretValue(
      args.appTicket,
      {},
    );
    signal.throwIfAborted();
    await set(writeDb$)
      .insert(feishuAppCredentials)
      .values({ appId: args.appId, encryptedAppTicket })
      .onConflictDoUpdate({
        target: feishuAppCredentials.appId,
        set: {
          encryptedAppTicket,
          encryptedAppAccessToken: null,
          appAccessTokenExpiresAt: null,
          updatedAt: nowDate(),
        },
      });
    signal.throwIfAborted();
  },
);

const recordInstallation$ = command(
  async (
    { set },
    args: { readonly appId: string; readonly tenantKey: string },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(writeDb$)
      .insert(feishuOrgInstallations)
      .values({
        feishuTenantKey: args.tenantKey,
        feishuAppId: args.appId,
      })
      .onConflictDoUpdate({
        target: feishuOrgInstallations.feishuTenantKey,
        set: { feishuAppId: args.appId, updatedAt: nowDate() },
      });
    signal.throwIfAborted();
  },
);

const removeInstallation$ = command(
  async ({ set }, tenantKey: string, signal: AbortSignal): Promise<void> => {
    await set(writeDb$)
      .delete(feishuOrgInstallations)
      .where(eq(feishuOrgInstallations.feishuTenantKey, tenantKey));
    signal.throwIfAborted();
  },
);

function inboundMessage(
  envelope: z.infer<typeof v2EnvelopeSchema>,
): FeishuInboundMessage | null {
  if (envelope.header.event_type !== "im.message.receive_v1") {
    return null;
  }
  const event = v2MessageEventSchema.safeParse(envelope.event);
  if (
    !event.success ||
    event.data.message.chat_type !== "p2p" ||
    event.data.message.message_type !== "text" ||
    event.data.sender.sender_type === "app"
  ) {
    return null;
  }
  const content = textContentSchema.safeParse(
    safeJsonParse(event.data.message.content),
  );
  const text = content.success ? content.data.text.trim() : "";
  if (!text) {
    return null;
  }
  return {
    eventId: envelope.header.event_id,
    tenantKey: envelope.header.tenant_key,
    appId: envelope.header.app_id,
    messageId: event.data.message.message_id,
    chatId: event.data.message.chat_id,
    openId: event.data.sender.sender_id.open_id,
    text,
  };
}

export const handleZeroFeishuEvents$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const config = feishuConfig();
    if (!config) {
      return jsonResponse(
        { error: "Feishu integration is not configured" },
        503,
      );
    }
    const request = get(request$);
    const rawBody = await request.text();
    signal.throwIfAborted();
    if (
      !verifySignature({
        rawBody,
        timestamp: request.header("x-lark-request-timestamp"),
        nonce: request.header("x-lark-request-nonce"),
        signature: request.header("x-lark-signature"),
        encryptKey: config.encryptKey,
      })
    ) {
      return jsonResponse({ error: "Invalid Feishu signature" }, 401);
    }

    const parsedBody = safeSync(() => {
      return parseBody(rawBody, config);
    });
    if ("error" in parsedBody) {
      return jsonResponse({ error: "Invalid Feishu payload" }, 400);
    }
    const payload = parsedBody.ok;
    const challenge = challengeSchema.safeParse(payload);
    if (challenge.success) {
      if (!validAppAndToken(undefined, challenge.data.token, config)) {
        return jsonResponse({ error: "Invalid Feishu token" }, 401);
      }
      return jsonResponse({ challenge: challenge.data.challenge });
    }

    const v2 = v2EnvelopeSchema.safeParse(payload);
    if (v2.success) {
      if (
        !validAppAndToken(v2.data.header.app_id, v2.data.header.token, config)
      ) {
        return jsonResponse({ error: "Invalid Feishu token" }, 401);
      }
      const message = inboundMessage(v2.data);
      if (message) {
        waitUntil(
          tapError(set(dispatchFeishuMessage$, message, signal), (error) => {
            L.error("Failed to dispatch Feishu message", {
              error,
              eventId: message.eventId,
            });
          }),
        );
      }
      return textResponse("OK");
    }

    const legacy = legacyEventSchema.safeParse(payload);
    if (!legacy.success) {
      return jsonResponse({ error: "Invalid Feishu event" }, 400);
    }
    const legacyEvent = legacy.data.event;
    if (!validAppAndToken(legacyEvent.app_id, legacy.data.token, config)) {
      return jsonResponse({ error: "Invalid Feishu token" }, 401);
    }
    if (legacyEvent.type === "app_ticket" && legacyEvent.app_ticket) {
      waitUntil(
        tapError(
          set(
            storeAppTicket$,
            {
              appId: legacyEvent.app_id,
              appTicket: legacyEvent.app_ticket,
            },
            signal,
          ),
          (error) => {
            L.error("Failed to store Feishu app ticket", { error });
          },
        ),
      );
    } else if (legacyEvent.type === "app_open" && legacyEvent.tenant_key) {
      waitUntil(
        tapError(
          set(
            recordInstallation$,
            {
              appId: legacyEvent.app_id,
              tenantKey: legacyEvent.tenant_key,
            },
            signal,
          ),
          (error) => {
            L.error("Failed to record Feishu installation", { error });
          },
        ),
      );
    } else if (
      legacyEvent.type === "app_uninstalled" &&
      legacyEvent.tenant_key
    ) {
      waitUntil(
        tapError(
          set(removeInstallation$, legacyEvent.tenant_key, signal),
          (error) => {
            L.error("Failed to remove Feishu installation", { error });
          },
        ),
      );
    }
    return textResponse("OK");
  },
);
