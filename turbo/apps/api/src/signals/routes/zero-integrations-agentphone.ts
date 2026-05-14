import { zeroIntegrationsAgentPhoneContract } from "@vm0/api-contracts/contracts/zero-integrations-agentphone";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { agentphoneVerificationSendCooldowns } from "@vm0/db/schema/agentphone-verification-send-cooldown";
import { agentphoneUserLinks } from "@vm0/db/schema/agentphone-user-link";
import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { now } from "../external/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import { sendAgentPhoneMessage } from "../external/agentphone-client";
import type { RouteEntry } from "../route";
import {
  buildAgentPhoneConnectUrl,
  describeAgentPhoneHandleShape,
  ensureAgentPhoneArtifactStorage$,
  handleAgentPhoneMessage$,
  isAgentPhoneChannel,
  isValidAgentPhoneHandle,
  linkAgentPhoneUserToVm0User,
  normalizeAgentPhoneHandle,
  publishAgentPhoneUserChanged,
  resolveAgentPhoneUserLink,
  storeInboundAgentPhoneMessage,
  verifyAgentPhoneConnectSignature,
  verifyAgentPhoneWebhook,
  type AgentPhoneChannel,
  type AgentPhoneMessageEvent,
} from "../services/zero-agentphone.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { safeJsonParse } from "../utils";

interface AgentPhoneConfig {
  readonly agentphoneAgentId: string | null;
  readonly agentPhoneNumber: string | null;
  readonly apiBaseUrl: string | null;
  readonly apiKey: string | null;
  readonly configured: boolean;
}

interface ConfiguredAgentPhoneConfig extends AgentPhoneConfig {
  readonly agentphoneAgentId: string;
  readonly apiBaseUrl: string;
  readonly apiKey: string;
}

const agentPhoneAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const VERIFICATION_SEND_COOLDOWN_MS = 60_000;
const log = logger("api:agentphone:link");

const startLinkBody$ = bodyResultOf(
  zeroIntegrationsAgentPhoneContract.startLink,
);
const connectBody$ = bodyResultOf(
  zeroIntegrationsAgentPhoneContract.connectAgentPhone,
);

const webhookBodySchema = z.record(z.string(), z.unknown());

type VerificationSendCooldownScope = "phone" | "user_org";

interface VerificationSendCooldownKey {
  readonly scope: VerificationSendCooldownScope;
  readonly scopeKey: string;
}

function forbidden() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "AgentPhone app UI is not enabled",
        code: "FORBIDDEN",
      },
    },
  };
}

function notConfigured() {
  return {
    status: 503 as const,
    body: {
      error: {
        message: "AgentPhone is not configured",
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
        message: "AgentPhone verification text could not be sent",
        code: "PROVIDER_UNAVAILABLE",
      },
    },
  };
}

function tooManyVerificationTexts() {
  return {
    status: 429 as const,
    body: {
      error: {
        message:
          "Verification text was just sent. Wait a minute before trying again.",
        code: "TOO_MANY_REQUESTS",
      },
    },
  };
}

function getAgentPhoneConfig(): AgentPhoneConfig {
  const agentphoneAgentId = optionalEnv("AGENTPHONE_AGENT_ID") ?? null;
  const apiBaseUrl = optionalEnv("AGENTPHONE_API_BASE_URL") ?? null;
  const apiKey = optionalEnv("AGENTPHONE_API_KEY") ?? null;
  const agentPhoneNumber = optionalEnv("AGENTPHONE_PHONE_NUMBER") ?? null;

  return {
    agentphoneAgentId,
    agentPhoneNumber,
    apiBaseUrl,
    apiKey,
    configured: Boolean(
      agentphoneAgentId && apiBaseUrl && apiKey && agentPhoneNumber,
    ),
  };
}

function agentPhoneCooldownKeys(params: {
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

function isValidPhoneHandle(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/u.test(value);
}

function maskPhoneHandle(value: string): string {
  const normalized = value.trim().replace(/[^\d+]/gu, "");
  if (normalized.length <= 4) {
    return "[redacted]";
  }
  return `***${normalized.slice(-4)}`;
}

function safeResponseText(response: Response): Promise<string> {
  return response.text().catch(() => {
    return "[unavailable]";
  });
}

function truncateForLog(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

async function sendAgentPhoneVerificationMessage(params: {
  readonly config: ConfiguredAgentPhoneConfig;
  readonly toNumber: string;
  readonly body: string;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const response = await fetch(`${params.config.apiBaseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_id: params.config.agentphoneAgentId,
      to_number: params.toNumber,
      body: params.body,
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    log.warn("AgentPhone verification text provider rejected send", {
      agentphoneAgentId: params.config.agentphoneAgentId,
      phoneHandle: maskPhoneHandle(params.toNumber),
      status: response.status,
      statusText: response.statusText,
      body: truncateForLog(await safeResponseText(response)),
    });
    return false;
  }

  return true;
}

// `startLink` only ever delivers via SMS, so we hard-code the channel for
// signing. Keep the HMAC payload format in lock-step with apps/web's
// `signAgentPhoneConnectParams` (`<handle>:<agentId>:<ts>:<channel>`) so the
// platform connect page can verify either origin's signature.
const APPS_API_CONNECT_CHANNEL: AgentPhoneChannel = "sms";

const requireAgentPhoneUi$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  const enabled = isFeatureEnabled(FeatureSwitchKey.AgentPhoneAppUi, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });

  if (!enabled) {
    return { ok: false as const, response: forbidden() };
  }

  return { ok: true as const, auth };
});

const getLinkStatus$ = computed(async (get) => {
  const gate = await get(requireAgentPhoneUi$);
  if (!gate.ok) {
    return gate.response;
  }

  const config = getAgentPhoneConfig();
  const [link] = await get(db$)
    .select()
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.vm0UserId, gate.auth.userId),
        eq(agentphoneUserLinks.orgId, gate.auth.orgId),
      ),
    )
    .limit(1);

  if (link) {
    return {
      status: 200 as const,
      body: {
        linked: true as const,
        phoneHandle: link.phoneHandle,
        agentPhoneNumber: config.agentPhoneNumber,
        configured: config.configured,
      },
    };
  }

  return {
    status: 200 as const,
    body: {
      linked: false as const,
      agentPhoneNumber: config.agentPhoneNumber,
      configured: config.configured,
    },
  };
});

const sendAgentPhoneVerificationText$ = command(
  async (
    { set },
    params: {
      readonly config: ConfiguredAgentPhoneConfig;
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
          .insert(agentphoneVerificationSendCooldowns)
          .values({
            scope: key.scope,
            scopeKey: key.scopeKey,
          })
          .onConflictDoNothing();

        const [cooldown] = await tx
          .select({
            lastSentAt: agentphoneVerificationSendCooldowns.lastSentAt,
          })
          .from(agentphoneVerificationSendCooldowns)
          .where(
            and(
              eq(agentphoneVerificationSendCooldowns.scope, key.scope),
              eq(agentphoneVerificationSendCooldowns.scopeKey, key.scopeKey),
            ),
          )
          .for("update")
          .limit(1);
        signal.throwIfAborted();

        if (
          cooldown?.lastSentAt &&
          cooldown.lastSentAt.getTime() > cooldownCutoff
        ) {
          return { ok: false as const, response: tooManyVerificationTexts() };
        }
      }

      const sent = await sendAgentPhoneVerificationMessage({
        config: params.config,
        toNumber: params.phoneHandle,
        body: `Confirm this phone number for VM0: ${params.connectUrl}`,
        signal,
      }).catch((error: unknown) => {
        log.error("AgentPhone verification text send failed", {
          agentphoneAgentId: params.config.agentphoneAgentId,
          phoneHandle: maskPhoneHandle(params.phoneHandle),
          error,
        });
        return false;
      });
      signal.throwIfAborted();

      if (!sent) {
        return { ok: false as const, response: unavailable() };
      }

      for (const key of params.cooldownKeys) {
        await tx
          .update(agentphoneVerificationSendCooldowns)
          .set({ lastSentAt: sentAt, updatedAt: sentAt })
          .where(
            and(
              eq(agentphoneVerificationSendCooldowns.scope, key.scope),
              eq(agentphoneVerificationSendCooldowns.scopeKey, key.scopeKey),
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
  const gate = await get(requireAgentPhoneUi$);
  signal.throwIfAborted();
  if (!gate.ok) {
    return gate.response;
  }

  const bodyResult = await get(startLinkBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const phoneHandle = bodyResult.data.phoneHandle
    .trim()
    .replace(/[^\d+]/gu, "");
  if (!isValidPhoneHandle(phoneHandle)) {
    return badRequestMessage(
      "Enter a phone number with country code, like +1 555 555 1212",
    );
  }

  const config = getAgentPhoneConfig();
  const agentphoneAgentId = config.agentphoneAgentId;
  const apiBaseUrl = config.apiBaseUrl;
  const apiKey = config.apiKey;
  if (!config.configured || !agentphoneAgentId || !apiBaseUrl || !apiKey) {
    return notConfigured();
  }

  const readDb = get(db$);
  const [currentLink] = await readDb
    .select()
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.vm0UserId, gate.auth.userId),
        eq(agentphoneUserLinks.orgId, gate.auth.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (currentLink) {
    return conflict(
      "Your VM0 account is already connected to a phone number in this organization. Disconnect it first.",
    );
  }

  const [existingPhoneLink] = await readDb
    .select()
    .from(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.phoneHandle, phoneHandle))
    .limit(1);
  signal.throwIfAborted();

  if (existingPhoneLink) {
    return conflict(
      "This phone number is already connected to another VM0 account or organization. Disconnect it first.",
    );
  }

  const connectUrl = buildAgentPhoneConnectUrl({
    phoneHandle,
    agentphoneAgentId,
    channel: APPS_API_CONNECT_CHANNEL,
    secret: env("SECRETS_ENCRYPTION_KEY"),
  });

  const cooldownKeys = agentPhoneCooldownKeys({
    orgId: gate.auth.orgId,
    userId: gate.auth.userId,
    phoneHandle,
  });
  const sendResult = await set(
    sendAgentPhoneVerificationText$,
    {
      config: {
        ...config,
        agentphoneAgentId,
        apiBaseUrl,
        apiKey,
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
  const gate = await get(requireAgentPhoneUi$);
  signal.throwIfAborted();
  if (!gate.ok) {
    return gate.response;
  }

  const deleted = await set(writeDb$)
    .delete(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.vm0UserId, gate.auth.userId),
        eq(agentphoneUserLinks.orgId, gate.auth.orgId),
      ),
    )
    .returning({ id: agentphoneUserLinks.id });
  signal.throwIfAborted();

  if (deleted.length === 0) {
    return notFound("No linked AgentPhone account");
  }

  return { status: 204 as const, body: undefined };
});

function connectConflict(reason: LinkConflictReason) {
  const message =
    reason === "phone-handle-linked"
      ? "This phone number is already connected to another VM0 account or organization. Disconnect it first."
      : reason === "vm0-org-linked"
        ? "Your VM0 account is already connected to another phone number in this organization. Disconnect it first."
        : "This phone number link already exists. Disconnect it first and try again.";

  return conflict(message);
}

type LinkConflictReason = "phone-handle-linked" | "vm0-org-linked" | "conflict";

const connectAgentPhone$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(connectBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    const channel: AgentPhoneChannel =
      body.channel && isAgentPhoneChannel(body.channel) ? body.channel : "sms";
    const phoneHandle = normalizeAgentPhoneHandle(body.phoneHandle, channel);
    if (
      !phoneHandle ||
      !verifyAgentPhoneConnectSignature({
        phoneHandle,
        agentphoneAgentId: body.agentphoneAgentId,
        timestamp: body.timestamp,
        channel,
        signature: body.signature,
        secret: env("SECRETS_ENCRYPTION_KEY"),
      })
    ) {
      return badRequestMessage(
        "Invalid or expired connection link. Send /connect again.",
      );
    }

    const writeDb = set(writeDb$);
    const result = await linkAgentPhoneUserToVm0User(writeDb, {
      phoneHandle,
      channel,
      vm0UserId: auth.userId,
      orgId: auth.orgId,
    });
    signal.throwIfAborted();

    if (!result.ok) {
      return connectConflict(result.reason);
    }

    await set(
      ensureAgentPhoneArtifactStorage$,
      { userId: auth.userId, orgId: auth.orgId },
      signal,
    );
    signal.throwIfAborted();

    await publishAgentPhoneUserChanged(auth.userId);
    signal.throwIfAborted();

    await sendAgentPhoneMessage(
      {
        agentphoneAgentId: body.agentphoneAgentId,
        toNumber: phoneHandle,
        body: "Your phone number is connected to VM0. Send a message here to start chatting with Zero.",
      },
      signal,
    ).catch((error: unknown) => {
      log.warn("Connected AgentPhone user but failed to send confirmation", {
        phoneHandle,
        vm0UserId: auth.userId,
        orgId: auth.orgId,
        error,
      });
    });
    signal.throwIfAborted();

    return { status: 200 as const, body: { phoneHandle } };
  },
);

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function okText(): Response {
  return textResponse("OK", 200);
}

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
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractAgentPhoneEvent(
  body: Record<string, unknown>,
  webhookId: string | null,
  channel: AgentPhoneChannel,
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

interface AgentPhoneWebhookConfig {
  readonly webhookSecret: string;
  readonly officialPhoneNumber: string;
}

function agentPhoneWebhookConfig(): AgentPhoneWebhookConfig | undefined {
  const webhookSecret = optionalEnv("AGENTPHONE_WEBHOOK_SECRET");
  const officialPhoneNumber = optionalEnv("AGENTPHONE_PHONE_NUMBER");
  if (!webhookSecret || !officialPhoneNumber) {
    return undefined;
  }
  return { webhookSecret, officialPhoneNumber };
}

const webhook$ = command(async ({ get, set }, signal: AbortSignal) => {
  const apiStartTime = now();
  const config = agentPhoneWebhookConfig();
  if (!config) {
    return textResponse("Not Found", 404);
  }

  const request = get(request$);
  const rawBody = await request.text();
  signal.throwIfAborted();

  if (
    !verifyAgentPhoneWebhook({
      rawBody,
      signature: request.header("x-webhook-signature") ?? null,
      timestamp: request.header("x-webhook-timestamp") ?? null,
      secret: config.webhookSecret,
    })
  ) {
    return textResponse("Unauthorized", 401);
  }

  const jsonBody = safeJsonParse(rawBody);
  if (jsonBody === undefined) {
    return textResponse("Bad Request", 400);
  }

  const parsed = webhookBodySchema.safeParse(jsonBody);
  if (!parsed.success) {
    return textResponse("Bad Request", 400);
  }

  const body = parsed.data;
  const eventType =
    stringValue(body, ["event"]) ?? request.header("x-webhook-event");
  if (eventType !== "agent.message") {
    return okText();
  }

  const data = valueObject(body.data);
  const rawChannel = (
    stringValue(body, ["channel"]) ??
    stringValue(data, ["channel"]) ??
    ""
  ).toLowerCase();
  if (!isAgentPhoneChannel(rawChannel)) {
    return okText();
  }

  const webhookId = request.header("x-webhook-id") ?? null;
  const event = extractAgentPhoneEvent(body, webhookId, rawChannel);
  if (!event) {
    return okText();
  }

  if (
    normalizeAgentPhoneHandle(event.toNumber, "sms") !==
    normalizeAgentPhoneHandle(config.officialPhoneNumber, "sms")
  ) {
    return okText();
  }

  const normalizedFrom = normalizeAgentPhoneHandle(
    event.fromNumber,
    rawChannel,
  );
  log.debug("AgentPhone webhook accepted", {
    webhookId,
    channel: rawChannel,
    fromShape: describeAgentPhoneHandleShape(event.fromNumber),
    fromHandleNormalized: Boolean(normalizedFrom),
    hasMedia: Boolean(event.mediaUrl),
  });

  if (!normalizedFrom || !isValidAgentPhoneHandle(normalizedFrom, rawChannel)) {
    log.warn("AgentPhone webhook from-handle is not usable", {
      webhookId,
      channel: rawChannel,
      fromShape: describeAgentPhoneHandleShape(event.fromNumber),
    });
    return okText();
  }

  const writeDb = set(writeDb$);
  const userLink = await resolveAgentPhoneUserLink(
    writeDb,
    event.fromNumber,
    rawChannel,
  );
  signal.throwIfAborted();

  const stored = await storeInboundAgentPhoneMessage(writeDb, {
    event,
    userLinkId: userLink?.id ?? null,
  });
  signal.throwIfAborted();
  if (!stored.inserted) {
    return okText();
  }

  waitUntil(
    set(
      handleAgentPhoneMessage$,
      { event, userLink, apiStartTime },
      signal,
    ).catch((error: unknown) => {
      log.error("Error handling AgentPhone webhook", { error });
    }),
  );

  return okText();
});

export const zeroIntegrationsAgentPhoneRoutes: readonly RouteEntry[] = [
  {
    route: zeroIntegrationsAgentPhoneContract.connectAgentPhone,
    handler: authRoute(agentPhoneAuthOptions, connectAgentPhone$),
  },
  {
    route: zeroIntegrationsAgentPhoneContract.webhook,
    handler: webhook$,
  },
  {
    route: zeroIntegrationsAgentPhoneContract.getLinkStatus,
    handler: authRoute(agentPhoneAuthOptions, getLinkStatus$),
  },
  {
    route: zeroIntegrationsAgentPhoneContract.startLink,
    handler: authRoute(agentPhoneAuthOptions, startLink$),
  },
  {
    route: zeroIntegrationsAgentPhoneContract.unlink,
    handler: authRoute(agentPhoneAuthOptions, unlink$),
  },
];
