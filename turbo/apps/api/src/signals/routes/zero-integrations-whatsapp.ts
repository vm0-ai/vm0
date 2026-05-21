import { createHmac, timingSafeEqual } from "node:crypto";

import { zeroIntegrationsWhatsAppContract } from "@vm0/api-contracts/contracts/zero-integrations-whatsapp";
import { whatsappUserLinks } from "@vm0/db/schema/whatsapp-user-link";
import { whatsappVerificationSendCooldowns } from "@vm0/db/schema/whatsapp-verification-send-cooldown";
import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import { now, nowDate } from "../external/time";
import { sendTwilioWhatsAppMessage } from "../external/twilio-client";
import type { RouteEntry } from "../route";
import {
  buildWhatsAppConnectUrl,
  getTwilioWhatsAppConfig,
  handleWhatsAppMessage$,
  isValidWhatsAppHandle,
  linkWhatsAppUserToVm0User,
  normalizeWhatsAppHandle,
  publishWhatsAppUserChanged,
  resolveWhatsAppUserLink,
  storeInboundWhatsAppMessage,
  verifyWhatsAppConnectSignature,
  type ConfiguredTwilioWhatsAppConfig,
  type WhatsAppMessageEvent,
} from "../services/zero-whatsapp.service";
import { tapError } from "../utils";

type VerificationSendCooldownScope = "phone" | "user_org";

interface VerificationSendCooldownKey {
  readonly scope: VerificationSendCooldownScope;
  readonly scopeKey: string;
}

const whatsAppAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const VERIFICATION_SEND_COOLDOWN_MS = 60_000;
const log = logger("api:whatsapp:link");

const startLinkBody$ = bodyResultOf(zeroIntegrationsWhatsAppContract.startLink);
const connectBody$ = bodyResultOf(
  zeroIntegrationsWhatsAppContract.connectWhatsApp,
);

function notConfigured() {
  return {
    status: 503 as const,
    body: {
      error: {
        message: "WhatsApp is not configured",
        code: "NOT_CONFIGURED",
      },
    },
  };
}

function unavailable() {
  return {
    status: 503 as const,
    body: {
      error: {
        message: "WhatsApp verification message could not be sent",
        code: "PROVIDER_UNAVAILABLE",
      },
    },
  };
}

function tooManyVerificationMessages() {
  return {
    status: 429 as const,
    body: {
      error: {
        message:
          "Verification message was just sent. Wait a minute before trying again.",
        code: "TOO_MANY_REQUESTS",
      },
    },
  };
}

function whatsAppCooldownKeys(params: {
  readonly orgId: string;
  readonly userId: string;
  readonly phoneHandle: string;
}): readonly VerificationSendCooldownKey[] {
  const keys: VerificationSendCooldownKey[] = [
    {
      scope: "phone",
      scopeKey: params.phoneHandle,
    },
    {
      scope: "user_org",
      scopeKey: `${params.orgId}:${params.userId}`,
    },
  ];

  return keys.sort((left, right) => {
    return `${left.scope}:${left.scopeKey}`.localeCompare(
      `${right.scope}:${right.scopeKey}`,
    );
  });
}

function maskPhoneHandle(value: string): string {
  const normalized = normalizeWhatsAppHandle(value);
  if (normalized.length <= 4) {
    return "[redacted]";
  }
  return `***${normalized.slice(-4)}`;
}

async function sendWhatsAppVerificationMessage(params: {
  readonly config: ConfiguredTwilioWhatsAppConfig;
  readonly toNumber: string;
  readonly body: string;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  await sendTwilioWhatsAppMessage(
    {
      accountSid: params.config.accountSid,
      authToken: params.config.authToken,
      fromNumber: params.config.fromNumber,
      toNumber: params.toNumber,
      body: params.body,
    },
    params.signal,
  );
  return true;
}

const getLinkStatus$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);

  const config = getTwilioWhatsAppConfig();
  const [link] = await get(db$)
    .select()
    .from(whatsappUserLinks)
    .where(
      and(
        eq(whatsappUserLinks.vm0UserId, auth.userId),
        eq(whatsappUserLinks.orgId, auth.orgId),
      ),
    )
    .limit(1);

  if (link) {
    return {
      status: 200 as const,
      body: {
        linked: true as const,
        phoneHandle: link.phoneHandle,
        whatsAppNumber: config.fromNumber,
        configured: config.configured,
      },
    };
  }

  return {
    status: 200 as const,
    body: {
      linked: false as const,
      whatsAppNumber: config.fromNumber,
      configured: config.configured,
    },
  };
});

const sendWhatsAppVerificationText$ = command(
  async (
    { set },
    params: {
      readonly config: ConfiguredTwilioWhatsAppConfig;
      readonly cooldownKeys: readonly VerificationSendCooldownKey[];
      readonly phoneHandle: string;
      readonly connectUrl: string;
    },
    signal: AbortSignal,
  ) => {
    const sendResult = await set(writeDb$).transaction(async (tx) => {
      const sentAt = new Date(now());
      const cooldownCutoff = sentAt.getTime() - VERIFICATION_SEND_COOLDOWN_MS;

      for (const key of params.cooldownKeys) {
        await tx
          .insert(whatsappVerificationSendCooldowns)
          .values({
            scope: key.scope,
            scopeKey: key.scopeKey,
          })
          .onConflictDoNothing();

        const [cooldown] = await tx
          .select({
            lastSentAt: whatsappVerificationSendCooldowns.lastSentAt,
          })
          .from(whatsappVerificationSendCooldowns)
          .where(
            and(
              eq(whatsappVerificationSendCooldowns.scope, key.scope),
              eq(whatsappVerificationSendCooldowns.scopeKey, key.scopeKey),
            ),
          )
          .for("update")
          .limit(1);
        signal.throwIfAborted();

        if (
          cooldown?.lastSentAt &&
          cooldown.lastSentAt.getTime() > cooldownCutoff
        ) {
          return {
            ok: false as const,
            response: tooManyVerificationMessages(),
          };
        }
      }

      const sent =
        (await tapError(
          sendWhatsAppVerificationMessage({
            config: params.config,
            toNumber: params.phoneHandle,
            body: `Confirm this WhatsApp number for VM0: ${params.connectUrl}`,
            signal,
          }),
          (error) => {
            log.error("WhatsApp verification message send failed", {
              phoneHandle: maskPhoneHandle(params.phoneHandle),
              error,
            });
          },
        )) ?? false;
      signal.throwIfAborted();

      if (!sent) {
        return { ok: false as const, response: unavailable() };
      }

      for (const key of params.cooldownKeys) {
        await tx
          .update(whatsappVerificationSendCooldowns)
          .set({ lastSentAt: sentAt, updatedAt: sentAt })
          .where(
            and(
              eq(whatsappVerificationSendCooldowns.scope, key.scope),
              eq(whatsappVerificationSendCooldowns.scopeKey, key.scopeKey),
            ),
          );
      }

      return { ok: true as const };
    });
    signal.throwIfAborted();

    return sendResult;
  },
);

const startLink$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const bodyResult = await get(startLinkBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const phoneHandle = normalizeWhatsAppHandle(bodyResult.data.phoneHandle);
  if (!isValidWhatsAppHandle(phoneHandle)) {
    return badRequestMessage(
      "Enter a phone number with country code, like +1 555 555 1212",
    );
  }

  const config = getTwilioWhatsAppConfig();
  const accountSid = config.accountSid;
  const authToken = config.authToken;
  const fromNumber = config.fromNumber;
  if (!config.configured || !accountSid || !authToken || !fromNumber) {
    return notConfigured();
  }

  const readDb = get(db$);
  const [currentLink] = await readDb
    .select()
    .from(whatsappUserLinks)
    .where(
      and(
        eq(whatsappUserLinks.vm0UserId, auth.userId),
        eq(whatsappUserLinks.orgId, auth.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (currentLink) {
    return conflict(
      "Your VM0 account is already connected to a WhatsApp number in this organization. Disconnect it first.",
    );
  }

  const [existingPhoneLink] = await readDb
    .select()
    .from(whatsappUserLinks)
    .where(eq(whatsappUserLinks.phoneHandle, phoneHandle))
    .limit(1);
  signal.throwIfAborted();

  if (existingPhoneLink) {
    return conflict(
      "This WhatsApp number is already connected to another VM0 account or organization. Disconnect it first.",
    );
  }

  const connectUrl = buildWhatsAppConnectUrl({
    phoneHandle,
    secret: env("SECRETS_ENCRYPTION_KEY"),
  });

  const cooldownKeys = whatsAppCooldownKeys({
    orgId: auth.orgId,
    userId: auth.userId,
    phoneHandle,
  });
  const sendResult = await set(
    sendWhatsAppVerificationText$,
    {
      config: {
        ...config,
        accountSid,
        authToken,
        fromNumber,
      },
      cooldownKeys,
      phoneHandle,
      connectUrl,
    },
    signal,
  );

  if (!sendResult.ok) {
    return sendResult.response;
  }

  return {
    status: 200 as const,
    body: { phoneHandle, verificationSent: true as const },
  };
});

const unlink$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const deleted = await set(writeDb$)
    .delete(whatsappUserLinks)
    .where(
      and(
        eq(whatsappUserLinks.vm0UserId, auth.userId),
        eq(whatsappUserLinks.orgId, auth.orgId),
      ),
    )
    .returning({ id: whatsappUserLinks.id });
  signal.throwIfAborted();

  if (deleted.length === 0) {
    return notFound("No linked WhatsApp account");
  }

  return { status: 204 as const, body: undefined };
});

type LinkConflictReason = "phone-handle-linked" | "vm0-org-linked" | "conflict";

function connectConflict(reason: LinkConflictReason) {
  const message =
    reason === "phone-handle-linked"
      ? "This WhatsApp number is already connected to another VM0 account or organization. Disconnect it first."
      : reason === "vm0-org-linked"
        ? "Your VM0 account is already connected to another WhatsApp number in this organization. Disconnect it first."
        : "This WhatsApp number link already exists. Disconnect it first and try again.";

  return conflict(message);
}

const connectWhatsApp$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(connectBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const config = getTwilioWhatsAppConfig();
  const accountSid = config.accountSid;
  const authToken = config.authToken;
  const fromNumber = config.fromNumber;
  if (!config.configured || !accountSid || !authToken || !fromNumber) {
    return notConfigured();
  }

  const body = bodyResult.data;
  const phoneHandle = normalizeWhatsAppHandle(body.phoneHandle);
  if (
    !phoneHandle ||
    !verifyWhatsAppConnectSignature({
      phoneHandle,
      timestamp: body.timestamp,
      signature: body.signature,
      secret: env("SECRETS_ENCRYPTION_KEY"),
    })
  ) {
    return badRequestMessage(
      "Invalid or expired connection link. Send /connect again.",
    );
  }

  const writeDb = set(writeDb$);
  const result = await linkWhatsAppUserToVm0User(writeDb, {
    phoneHandle,
    vm0UserId: auth.userId,
    orgId: auth.orgId,
  });
  signal.throwIfAborted();

  if (!result.ok) {
    return connectConflict(result.reason);
  }

  await publishWhatsAppUserChanged(auth.userId);
  signal.throwIfAborted();

  await tapError(
    sendTwilioWhatsAppMessage(
      {
        accountSid,
        authToken,
        fromNumber,
        toNumber: phoneHandle,
        body: "Your WhatsApp number is connected to VM0. Send a message here to start chatting with Zero.",
      },
      signal,
    ),
    (error) => {
      log.warn("Connected WhatsApp user but failed to send confirmation", {
        phoneHandle: maskPhoneHandle(phoneHandle),
        vm0UserId: auth.userId,
        orgId: auth.orgId,
        error,
      });
    },
  );
  signal.throwIfAborted();

  return { status: 200 as const, body: { phoneHandle } };
});

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function okText(): Response {
  return textResponse("OK", 200);
}

function sortedTwilioParams(params: URLSearchParams) {
  return [...params.entries()].sort((left, right) => {
    if (left[0] !== right[0]) {
      return left[0] < right[0] ? -1 : 1;
    }
    if (left[1] === right[1]) {
      return 0;
    }
    return left[1] < right[1] ? -1 : 1;
  });
}

function verifyTwilioWebhookSignature(params: {
  readonly url: string;
  readonly form: URLSearchParams;
  readonly signature: string | null;
  readonly authToken: string;
}): boolean {
  if (!params.signature) {
    return false;
  }
  const signed = sortedTwilioParams(params.form).reduce((acc, [key, value]) => {
    return `${acc}${key}${value}`;
  }, params.url);
  const expected = createHmac("sha1", params.authToken)
    .update(signed)
    .digest("base64");
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(params.signature);
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

function formValue(form: URLSearchParams, key: string): string | null {
  const value = form.get(key);
  return value?.trim() ? value : null;
}

function numberValue(form: URLSearchParams, key: string): number {
  const value = Number(formValue(form, key) ?? "0");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function mediaUrlsFromForm(form: URLSearchParams): readonly string[] {
  const count = numberValue(form, "NumMedia");
  const mediaUrls: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const mediaUrl = formValue(form, `MediaUrl${index}`);
    if (mediaUrl) {
      mediaUrls.push(mediaUrl);
    }
  }
  return mediaUrls;
}

function extractTwilioWhatsAppEvent(
  form: URLSearchParams,
): WhatsAppMessageEvent | null {
  const messageSid =
    formValue(form, "MessageSid") ??
    formValue(form, "SmsMessageSid") ??
    formValue(form, "SmsSid");
  const fromNumber = formValue(form, "From");
  const toNumber = formValue(form, "To");
  const body = formValue(form, "Body") ?? "";
  const mediaUrls = mediaUrlsFromForm(form);

  if (!messageSid || !fromNumber || !toNumber) {
    log.warn("Missing required fields in Twilio WhatsApp webhook", {
      hasMessageSid: Boolean(messageSid),
      hasFromNumber: Boolean(fromNumber),
      hasToNumber: Boolean(toNumber),
    });
    return null;
  }

  return {
    webhookId: messageSid,
    messageSid,
    fromNumber,
    toNumber,
    body,
    mediaUrls,
    receivedAt: nowDate(),
  };
}

function shouldAcceptTwilioEvent(args: {
  readonly event: WhatsAppMessageEvent;
  readonly fromNumber: string;
}): boolean {
  if (
    normalizeWhatsAppHandle(args.event.toNumber) !==
    normalizeWhatsAppHandle(args.fromNumber)
  ) {
    return false;
  }

  const normalizedFrom = normalizeWhatsAppHandle(args.event.fromNumber);
  if (!normalizedFrom || !isValidWhatsAppHandle(normalizedFrom)) {
    log.warn("Twilio WhatsApp webhook from-handle is not usable", {
      fromHandleNormalized: Boolean(normalizedFrom),
    });
    return false;
  }

  return true;
}

const webhook$ = command(async ({ get, set }, signal: AbortSignal) => {
  const apiStartTime = now();
  const config = getTwilioWhatsAppConfig();
  const accountSid = config.accountSid;
  const authToken = config.authToken;
  const fromNumber = config.fromNumber;
  if (!config.configured || !accountSid || !authToken || !fromNumber) {
    return textResponse("Not Found", 404);
  }

  const request = get(request$);
  const rawBody = await request.text();
  signal.throwIfAborted();

  const form = new URLSearchParams(rawBody);
  const webhookUrl = config.webhookUrl ?? request.raw.url;
  if (
    !verifyTwilioWebhookSignature({
      url: webhookUrl,
      form,
      signature: request.header("x-twilio-signature") ?? null,
      authToken,
    })
  ) {
    return textResponse("Unauthorized", 401);
  }

  const event = extractTwilioWhatsAppEvent(form);
  if (!event) {
    return okText();
  }

  if (!shouldAcceptTwilioEvent({ event, fromNumber })) {
    return okText();
  }

  if (!event.body.trim() && event.mediaUrls.length === 0) {
    return okText();
  }

  const writeDb = set(writeDb$);
  const userLink = await resolveWhatsAppUserLink(writeDb, event.fromNumber);
  signal.throwIfAborted();

  const stored = await storeInboundWhatsAppMessage(writeDb, {
    event,
    userLinkId: userLink?.id ?? null,
  });
  signal.throwIfAborted();
  if (!stored.inserted) {
    return okText();
  }

  waitUntil(
    tapError(
      set(handleWhatsAppMessage$, { event, userLink, apiStartTime }, signal),
      (error) => {
        log.error("Error handling Twilio WhatsApp webhook", { error });
      },
    ),
  );

  return okText();
});

export const zeroIntegrationsWhatsAppRoutes: readonly RouteEntry[] = [
  {
    route: zeroIntegrationsWhatsAppContract.connectWhatsApp,
    handler: authRoute(whatsAppAuthOptions, connectWhatsApp$),
  },
  {
    route: zeroIntegrationsWhatsAppContract.webhook,
    handler: webhook$,
  },
  {
    route: zeroIntegrationsWhatsAppContract.getLinkStatus,
    handler: authRoute(whatsAppAuthOptions, getLinkStatus$),
  },
  {
    route: zeroIntegrationsWhatsAppContract.startLink,
    handler: authRoute(whatsAppAuthOptions, startLink$),
  },
  {
    route: zeroIntegrationsWhatsAppContract.unlink,
    handler: authRoute(whatsAppAuthOptions, unlink$),
  },
];
