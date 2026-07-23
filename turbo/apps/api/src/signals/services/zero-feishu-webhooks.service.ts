import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { zeroFeishuEventsContract } from "@vm0/api-contracts/contracts/zero-feishu-events";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import { logger } from "../../lib/log";
import { request$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import { safeJsonParse, safeSync, tapError } from "../utils";
import {
  loadFeishuInstallationConfig,
  type FeishuInstallationConfig,
} from "./feishu-config";
import {
  dispatchFeishuMessage$,
  type FeishuInboundMessage,
} from "./zero-feishu-dispatch.service";
import { publishFeishuOrgChanged } from "./zero-feishu-realtime.service";

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

async function markCallbackVerified(args: {
  readonly db: Db;
  readonly config: FeishuInstallationConfig;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.config.callbackVerified) {
    return;
  }
  await args.db
    .update(feishuOrgInstallations)
    .set({ callbackVerifiedAt: nowDate(), updatedAt: nowDate() })
    .where(eq(feishuOrgInstallations.id, args.config.id));
  args.signal.throwIfAborted();
  await publishFeishuOrgChanged(
    args.db,
    args.config.orgId,
    args.config.ownerUserId,
  );
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

function inboundMessage(
  installationId: string,
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
    installationId,
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
    const request = get(request$);
    const params = get(pathParamsOf(zeroFeishuEventsContract.post));
    const db = set(writeDb$);
    const config = await loadFeishuInstallationConfig(
      db,
      params.installationId,
    );
    signal.throwIfAborted();
    if (!config) {
      return jsonResponse({ error: "Feishu installation not found" }, 404);
    }
    L.debug("Received Feishu callback", {
      installationId: config.id,
    });
    const rawBody = await request.text();
    signal.throwIfAborted();
    const parsedOuterBody = safeSync(() => {
      return JSON.parse(rawBody) as unknown;
    });
    if ("error" in parsedOuterBody) {
      L.warn("Rejected Feishu callback with invalid JSON", {
        installationId: config.id,
      });
      return jsonResponse({ error: "Invalid Feishu payload" }, 400);
    }
    const encrypted = encryptedBodySchema.safeParse(parsedOuterBody.ok);
    if (encrypted.success && !config.encryptKey) {
      L.warn("Rejected encrypted Feishu callback without an Encrypt Key", {
        installationId: config.id,
      });
      return jsonResponse({ error: "Invalid Feishu payload" }, 400);
    }
    const decryptedBody = encrypted.success
      ? safeSync(() => {
          return decryptPayload(encrypted.data.encrypt, config.encryptKey);
        })
      : { ok: parsedOuterBody.ok };
    if ("error" in decryptedBody) {
      return jsonResponse({ error: "Invalid Feishu payload" }, 400);
    }
    const payload = decryptedBody.ok;
    const challenge = challengeSchema.safeParse(payload);
    if (challenge.success) {
      if (challenge.data.token !== config.verificationToken) {
        L.warn("Rejected Feishu URL verification with an invalid token", {
          installationId: config.id,
        });
        return jsonResponse({ error: "Invalid Feishu token" }, 401);
      }
      await markCallbackVerified({ db, config, signal });
      L.debug("Verified Feishu callback URL", {
        installationId: config.id,
      });
      return jsonResponse({ challenge: challenge.data.challenge });
    }

    if (
      encrypted.success &&
      !verifySignature({
        rawBody,
        timestamp: request.header("x-lark-request-timestamp"),
        nonce: request.header("x-lark-request-nonce"),
        signature: request.header("x-lark-signature"),
        encryptKey: config.encryptKey,
      })
    ) {
      L.warn("Rejected encrypted Feishu event with an invalid signature", {
        installationId: config.id,
        hasTimestamp: Boolean(request.header("x-lark-request-timestamp")),
        hasNonce: Boolean(request.header("x-lark-request-nonce")),
        hasSignature: Boolean(request.header("x-lark-signature")),
      });
      return jsonResponse({ error: "Invalid Feishu signature" }, 401);
    }

    const v2 = v2EnvelopeSchema.safeParse(payload);
    if (!v2.success) {
      L.warn("Rejected Feishu callback with an invalid payload", {
        installationId: config.id,
      });
      return jsonResponse({ error: "Invalid Feishu event" }, 400);
    }
    if (
      v2.data.header.app_id !== config.appId ||
      v2.data.header.token !== config.verificationToken
    ) {
      L.warn("Rejected Feishu event with invalid app credentials", {
        installationId: config.id,
      });
      return jsonResponse({ error: "Invalid Feishu token" }, 401);
    }
    await markCallbackVerified({ db, config, signal });
    const message = inboundMessage(config.id, v2.data);
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
  },
);
