import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { command, type Getter, type Setter } from "ccstate";
import { formatRunErrorForExternalSurface } from "@vm0/api-contracts/contracts/errors";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { whatsappMessages } from "@vm0/db/schema/whatsapp-message";
import { whatsappThreadSessions } from "@vm0/db/schema/whatsapp-thread-session";
import { whatsappUserLinks } from "@vm0/db/schema/whatsapp-user-link";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, desc, eq } from "drizzle-orm";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate } from "../external/time";
import { publishUserSignal } from "../external/realtime";
import { sendTwilioWhatsAppMessage } from "../external/twilio-client";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import { canReuseIntegrationSessionForModelRoute } from "./integration-session-model-compatibility.service";
import {
  resolveIntegrationModelRouteForUser,
  type IntegrationModelRoutePin,
} from "./integration-model-route.service";
import { createZeroRun$ } from "./zero-runs-create.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import {
  formatAgentPhoneAuditLink,
  markdownToImessagePlain,
  resolveAgentPhoneAuditLogsUrl,
} from "./zero-agentphone.service";

const log = logger("api:whatsapp");
const MAX_CONNECT_AGE_SECONDS = 600;
const MAX_CONTEXT_MESSAGES = 10;
const WHATSAPP_DM_ROOT_MESSAGE_ID = "dm";
const WHATSAPP_MESSAGE_CHUNK_SIZE = 1500;

interface TwilioWhatsAppConfig {
  readonly accountSid: string | null;
  readonly authToken: string | null;
  readonly fromNumber: string | null;
  readonly webhookUrl: string | null;
  readonly configured: boolean;
}

export interface ConfiguredTwilioWhatsAppConfig extends TwilioWhatsAppConfig {
  readonly accountSid: string;
  readonly authToken: string;
  readonly fromNumber: string;
}

type WhatsAppUserLink = typeof whatsappUserLinks.$inferSelect;
type ModelRoutePin = IntegrationModelRoutePin;
type ComputedGetter = Getter;
type ComputedSetter = Setter;

interface WorkspaceAgent {
  readonly composeId: string;
  readonly agentId: string;
  readonly name: string;
  readonly displayName: string | null;
}

interface ThreadSessionLookup {
  readonly existingSessionId: string | undefined;
  readonly lastProcessedMessageId: string | undefined;
}

interface RunAgentResult {
  readonly status: "accepted" | "queued" | "failed";
  readonly response?: string;
  readonly runId?: string;
}

export interface WhatsAppMessageEvent {
  readonly webhookId: string | null;
  readonly messageSid: string;
  readonly fromNumber: string;
  readonly toNumber: string;
  readonly body: string;
  readonly mediaUrls: readonly string[];
  readonly receivedAt: Date | null;
}

interface WhatsAppCallbackContext {
  readonly messageSid: string;
  readonly rootMessageId: string;
  readonly phoneHandle: string;
  readonly fromNumber: string;
  readonly toNumber: string;
  readonly userLinkId: string;
  readonly agentId: string;
  readonly existingSessionId: string | null;
}

type LinkWhatsAppUserResult =
  | { readonly ok: true; readonly userLink: WhatsAppUserLink }
  | {
      readonly ok: false;
      readonly reason: "phone-handle-linked" | "vm0-org-linked" | "conflict";
      readonly userLink?: WhatsAppUserLink;
    };

export function getTwilioWhatsAppConfig(): TwilioWhatsAppConfig {
  const accountSid = optionalEnv("TWILIO_ACCOUNT_SID") ?? null;
  const authToken = optionalEnv("TWILIO_AUTH_TOKEN") ?? null;
  const fromNumber = optionalEnv("TWILIO_WHATSAPP_FROM_NUMBER") ?? null;
  const webhookUrl = optionalEnv("TWILIO_WHATSAPP_WEBHOOK_URL") ?? null;

  return {
    accountSid,
    authToken,
    fromNumber: fromNumber ? normalizeWhatsAppHandle(fromNumber) : null,
    webhookUrl,
    configured: Boolean(accountSid && authToken && fromNumber),
  };
}

export function normalizeWhatsAppHandle(handle: string): string {
  return handle
    .trim()
    .replace(/^whatsapp:/iu, "")
    .replace(/[^\d+]/gu, "");
}

export function isValidWhatsAppHandle(handle: string): boolean {
  return /^\+[1-9]\d{7,14}$/u.test(handle);
}

function normalizeHandleForConnect(handle: string): string {
  return normalizeWhatsAppHandle(handle);
}

export function signWhatsAppConnectParams(params: {
  readonly phoneHandle: string;
  readonly timestamp: number;
  readonly secret: string;
}): string {
  return createHmac("sha256", params.secret)
    .update(
      `${normalizeHandleForConnect(params.phoneHandle)}:${String(
        params.timestamp,
      )}`,
    )
    .digest("hex");
}

export function verifyWhatsAppConnectSignature(params: {
  readonly phoneHandle: string;
  readonly timestamp: number;
  readonly signature: string;
  readonly secret: string;
}): boolean {
  const nowSeconds = Math.floor(now() / 1000);
  if (Math.abs(nowSeconds - params.timestamp) > MAX_CONNECT_AGE_SECONDS) {
    return false;
  }

  const expected = signWhatsAppConnectParams({
    phoneHandle: params.phoneHandle,
    timestamp: params.timestamp,
    secret: params.secret,
  });
  if (!/^[0-9a-f]+$/iu.test(params.signature)) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, "hex");
  const signatureBuffer = Buffer.from(params.signature, "hex");
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

export function buildWhatsAppConnectUrl(params: {
  readonly phoneHandle: string;
  readonly secret: string;
}): string {
  const timestamp = Math.floor(now() / 1000);
  const phoneHandle = normalizeWhatsAppHandle(params.phoneHandle);
  const query = new URLSearchParams({
    handle: phoneHandle,
    ts: String(timestamp),
    sig: signWhatsAppConnectParams({
      phoneHandle,
      timestamp,
      secret: params.secret,
    }),
  });
  return `${env("APP_URL").replace(/\/$/u, "")}/whatsapp/connect?${query.toString()}`;
}

async function touchWhatsAppUserLink(
  db: Db,
  userLink: WhatsAppUserLink,
  phoneHandle: string,
): Promise<WhatsAppUserLink> {
  const normalized = normalizeWhatsAppHandle(phoneHandle);
  if (userLink.phoneHandle === normalized) {
    return userLink;
  }

  const [updated] = await db
    .update(whatsappUserLinks)
    .set({ phoneHandle: normalized, updatedAt: nowDate() })
    .where(eq(whatsappUserLinks.id, userLink.id))
    .returning();

  return updated ?? userLink;
}

export async function linkWhatsAppUserToVm0User(
  db: Db,
  params: {
    readonly phoneHandle: string;
    readonly vm0UserId: string;
    readonly orgId: string;
  },
): Promise<LinkWhatsAppUserResult> {
  const phoneHandle = normalizeWhatsAppHandle(params.phoneHandle);
  const [existingPhoneLink] = await db
    .select()
    .from(whatsappUserLinks)
    .where(eq(whatsappUserLinks.phoneHandle, phoneHandle))
    .limit(1);

  if (existingPhoneLink) {
    if (
      existingPhoneLink.vm0UserId === params.vm0UserId &&
      existingPhoneLink.orgId === params.orgId
    ) {
      return {
        ok: true,
        userLink: await touchWhatsAppUserLink(
          db,
          existingPhoneLink,
          phoneHandle,
        ),
      };
    }

    return {
      ok: false,
      reason: "phone-handle-linked",
      userLink: existingPhoneLink,
    };
  }

  const [existingVm0OrgLink] = await db
    .select()
    .from(whatsappUserLinks)
    .where(
      and(
        eq(whatsappUserLinks.vm0UserId, params.vm0UserId),
        eq(whatsappUserLinks.orgId, params.orgId),
      ),
    )
    .limit(1);

  if (existingVm0OrgLink) {
    if (existingVm0OrgLink.phoneHandle === phoneHandle) {
      return {
        ok: true,
        userLink: await touchWhatsAppUserLink(
          db,
          existingVm0OrgLink,
          phoneHandle,
        ),
      };
    }

    return {
      ok: false,
      reason: "vm0-org-linked",
      userLink: existingVm0OrgLink,
    };
  }

  const [inserted] = await db
    .insert(whatsappUserLinks)
    .values({
      phoneHandle,
      vm0UserId: params.vm0UserId,
      orgId: params.orgId,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) {
    return { ok: true, userLink: inserted };
  }
  return { ok: false, reason: "conflict" };
}

export async function resolveWhatsAppUserLink(
  db: Db,
  phoneHandle: string,
): Promise<WhatsAppUserLink | null> {
  const normalized = normalizeWhatsAppHandle(phoneHandle);
  if (!normalized) {
    return null;
  }
  const [userLink] = await db
    .select()
    .from(whatsappUserLinks)
    .where(eq(whatsappUserLinks.phoneHandle, normalized))
    .limit(1);

  return userLink ? touchWhatsAppUserLink(db, userLink, normalized) : null;
}

export async function storeInboundWhatsAppMessage(
  db: Db,
  params: {
    readonly event: WhatsAppMessageEvent;
    readonly userLinkId?: string | null;
  },
): Promise<{ readonly inserted: boolean }> {
  const fromNumber = normalizeWhatsAppHandle(params.event.fromNumber);
  const toNumber = normalizeWhatsAppHandle(params.event.toNumber);
  const inserted = await db
    .insert(whatsappMessages)
    .values({
      webhookId: params.event.webhookId,
      twilioMessageSid: params.event.messageSid,
      whatsappUserLinkId: params.userLinkId ?? null,
      phoneHandle: fromNumber,
      fromNumber,
      toNumber,
      direction: "inbound",
      body: params.event.body || null,
      mediaUrls: [...params.event.mediaUrls],
      isBot: false,
      receivedAt: params.event.receivedAt,
    })
    .onConflictDoNothing()
    .returning({ id: whatsappMessages.id });

  return { inserted: inserted.length > 0 };
}

export async function storeOutboundWhatsAppMessage(
  db: Db,
  params: {
    readonly twilioMessageSid: string;
    readonly userLinkId: string;
    readonly phoneHandle: string;
    readonly fromNumber: string;
    readonly toNumber: string;
    readonly body: string | undefined;
    readonly mediaUrls?: readonly string[] | null;
  },
): Promise<void> {
  const phoneHandle = normalizeWhatsAppHandle(params.phoneHandle);
  await db
    .insert(whatsappMessages)
    .values({
      twilioMessageSid: params.twilioMessageSid,
      whatsappUserLinkId: params.userLinkId,
      phoneHandle,
      fromNumber: normalizeWhatsAppHandle(params.fromNumber),
      toNumber: normalizeWhatsAppHandle(params.toNumber),
      direction: "outbound",
      body: params.body ?? null,
      mediaUrls: [...(params.mediaUrls ?? [])],
      isBot: true,
    })
    .onConflictDoNothing();
}

async function resolveOrgDefaultComposeId(
  db: ReadonlyDb,
  orgId: string,
): Promise<string | null> {
  const [metadata] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return metadata?.defaultAgentId ?? null;
}

async function getWorkspaceAgent(
  db: ReadonlyDb,
  composeId: string,
): Promise<WorkspaceAgent | null> {
  const [row] = await db
    .select({
      composeId: agentComposes.id,
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
    })
    .from(agentComposes)
    .innerJoin(zeroAgents, eq(zeroAgents.id, agentComposes.id))
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    composeId: row.composeId,
    agentId: row.composeId,
    name: row.name,
    displayName: row.displayName,
  };
}

async function resolveWhatsAppAgent(
  db: ReadonlyDb,
  userLink: WhatsAppUserLink,
): Promise<WorkspaceAgent | undefined> {
  const composeId = await resolveOrgDefaultComposeId(db, userLink.orgId);
  if (!composeId) {
    return undefined;
  }
  return (await getWorkspaceAgent(db, composeId)) ?? undefined;
}

async function lookupWhatsAppThreadSession(
  db: ReadonlyDb,
  userLinkId: string,
  rootMessageId: string,
): Promise<ThreadSessionLookup> {
  const [session] = await db
    .select({
      agentSessionId: whatsappThreadSessions.agentSessionId,
      lastProcessedMessageId: whatsappThreadSessions.lastProcessedMessageId,
    })
    .from(whatsappThreadSessions)
    .where(
      and(
        eq(whatsappThreadSessions.whatsappUserLinkId, userLinkId),
        eq(whatsappThreadSessions.rootMessageId, rootMessageId),
      ),
    )
    .limit(1);

  return {
    existingSessionId: session?.agentSessionId,
    lastProcessedMessageId: session?.lastProcessedMessageId ?? undefined,
  };
}

async function resolveCompatibleWhatsAppThreadSession(args: {
  readonly db: ReadonlyDb;
  readonly userLinkId: string;
  readonly userId: string;
  readonly agentComposeId: string;
  readonly rootMessageId: string;
  readonly modelRoute: ModelRoutePin | undefined;
}): Promise<ThreadSessionLookup> {
  const session = await lookupWhatsAppThreadSession(
    args.db,
    args.userLinkId,
    args.rootMessageId,
  );
  if (!session.existingSessionId) {
    return session;
  }

  const [agentSession] = await args.db
    .select({
      agentComposeId: agentSessions.agentComposeId,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, session.existingSessionId),
        eq(agentSessions.userId, args.userId),
      ),
    )
    .limit(1);
  if (agentSession?.agentComposeId !== args.agentComposeId) {
    return { existingSessionId: undefined, lastProcessedMessageId: undefined };
  }

  if (args.modelRoute) {
    const canReuseSession = await canReuseIntegrationSessionForModelRoute({
      db: args.db,
      sessionId: session.existingSessionId,
      modelRoute: args.modelRoute,
    });
    if (!canReuseSession) {
      return {
        existingSessionId: undefined,
        lastProcessedMessageId: undefined,
      };
    }
  }

  return session;
}

export async function saveWhatsAppThreadSession(
  db: Db,
  opts: {
    readonly userLinkId: string;
    readonly rootMessageId: string;
    readonly existingSessionId: string | undefined;
    readonly newSessionId: string | undefined;
    readonly messageSid: string;
    readonly runStatus: string;
  },
): Promise<void> {
  if (!opts.existingSessionId && opts.newSessionId) {
    const updated = await db
      .update(whatsappThreadSessions)
      .set({
        agentSessionId: opts.newSessionId,
        lastProcessedMessageId: opts.messageSid,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(whatsappThreadSessions.whatsappUserLinkId, opts.userLinkId),
          eq(whatsappThreadSessions.rootMessageId, opts.rootMessageId),
        ),
      )
      .returning({ id: whatsappThreadSessions.id });

    if (updated.length > 0) {
      return;
    }

    await db
      .insert(whatsappThreadSessions)
      .values({
        whatsappUserLinkId: opts.userLinkId,
        rootMessageId: opts.rootMessageId,
        agentSessionId: opts.newSessionId,
        lastProcessedMessageId: opts.messageSid,
      })
      .onConflictDoNothing();
    return;
  }

  if (
    opts.existingSessionId &&
    (opts.runStatus === "completed" || opts.runStatus === "timeout")
  ) {
    await db
      .update(whatsappThreadSessions)
      .set({
        lastProcessedMessageId: opts.messageSid,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(whatsappThreadSessions.whatsappUserLinkId, opts.userLinkId),
          eq(whatsappThreadSessions.rootMessageId, opts.rootMessageId),
        ),
      );
  }
}

function formatWhatsAppMediaForContext(params: {
  readonly messageSid: string;
  readonly mediaUrls: readonly string[];
}): string {
  return params.mediaUrls
    .map((mediaUrl, index) => {
      return `[WhatsApp media ${index + 1}] ${mediaUrl}\n   [ID] ${params.messageSid}`;
    })
    .join("\n");
}

function formatWhatsAppStoredContext(params: {
  readonly messages: readonly {
    readonly messageSid: string;
    readonly body: string | null;
    readonly mediaUrls: readonly string[];
    readonly isBot: boolean;
    readonly direction: string;
    readonly fromNumber: string;
  }[];
  readonly currentMessageSid?: string;
  readonly fallbackSender: string;
}): string {
  const chronological = [...params.messages].reverse().filter((message) => {
    return (
      !params.currentMessageSid ||
      message.messageSid !== params.currentMessageSid
    );
  });
  if (chronological.length === 0) {
    return "";
  }

  const total = chronological.length;
  const formatted = chronological.map((message, index) => {
    const sender = message.isBot ? "BOT" : params.fallbackSender;
    const parts = [
      "---",
      "",
      `- RELATIVE_INDEX: ${index - total}`,
      `- MSG_ID: ${message.messageSid}`,
      `- SENDER: {id: ${sender}}`,
      `- DIRECTION: ${message.direction}`,
      "",
      message.body ?? "",
    ];
    if (message.mediaUrls.length > 0) {
      parts.push(
        "",
        formatWhatsAppMediaForContext({
          messageSid: message.messageSid,
          mediaUrls: message.mediaUrls,
        }),
      );
    }
    return parts.join("\n");
  });

  return [
    "# WhatsApp Message Context",
    "",
    "The messages below are from the user's WhatsApp conversation with the shared Zero number. Messages closer to RELATIVE_INDEX 0 are more recent.",
    "",
    formatted.join("\n\n"),
    "",
    "---",
  ].join("\n");
}

async function fetchWhatsAppContext(
  db: ReadonlyDb,
  params: {
    readonly userLinkId: string;
    readonly phoneHandle: string;
    readonly currentMessageSid?: string;
  },
): Promise<{ readonly executionContext: string }> {
  const phoneHandle = normalizeWhatsAppHandle(params.phoneHandle);
  const messages = await db
    .select({
      messageSid: whatsappMessages.twilioMessageSid,
      body: whatsappMessages.body,
      mediaUrls: whatsappMessages.mediaUrls,
      isBot: whatsappMessages.isBot,
      direction: whatsappMessages.direction,
      fromNumber: whatsappMessages.fromNumber,
    })
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.whatsappUserLinkId, params.userLinkId),
        eq(whatsappMessages.phoneHandle, phoneHandle),
      ),
    )
    .orderBy(desc(whatsappMessages.createdAt))
    .limit(MAX_CONTEXT_MESSAGES);

  return {
    executionContext: formatWhatsAppStoredContext({
      messages,
      currentMessageSid: params.currentMessageSid,
      fallbackSender: phoneHandle,
    }),
  };
}

function enrichWhatsAppPrompt(opts: {
  readonly prompt: string;
  readonly phoneHandle: string;
  readonly messageSid: string;
  readonly mediaUrls: readonly string[];
}): {
  readonly prompt: string;
  readonly userInfoExtras: { readonly whatsappHandle: string };
} {
  const normalized = normalizeWhatsAppHandle(opts.phoneHandle);
  const parts = [opts.prompt.trim()];
  if (opts.mediaUrls.length > 0) {
    parts.push(
      formatWhatsAppMediaForContext({
        messageSid: opts.messageSid,
        mediaUrls: opts.mediaUrls,
      }),
    );
  }
  return {
    prompt: parts.filter(Boolean).join("\n\n"),
    userInfoExtras: { whatsappHandle: normalized },
  };
}

function buildWhatsAppRunPrompt(
  opts: {
    readonly sharedNumber: string;
    readonly phoneHandle: string;
    readonly messageSid?: string;
  },
  threadContext: string,
): string {
  const headerParts = [
    "# Current Integration",
    "You are currently running inside: WhatsApp via Twilio",
    `Shared WhatsApp number: ${opts.sharedNumber}`,
    `User WhatsApp handle: ${opts.phoneHandle}`,
  ];
  if (opts.messageSid) {
    headerParts.push(`Twilio Message SID: ${opts.messageSid}`);
  }
  return [headerParts.join("\n"), threadContext].filter(Boolean).join("\n\n");
}

function parseWhatsAppCommand(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const firstWord = trimmed.split(/\s/u)[0];
  return firstWord ? firstWord.slice(1).toLowerCase() : undefined;
}

async function sendWhatsAppText(
  toNumber: string,
  body: string,
  signal: AbortSignal,
): Promise<void> {
  const config = getTwilioWhatsAppConfig();
  if (
    !config.configured ||
    !config.accountSid ||
    !config.authToken ||
    !config.fromNumber
  ) {
    throw new Error("Twilio WhatsApp is not configured");
  }

  await sendTwilioWhatsAppMessage(
    {
      accountSid: config.accountSid,
      authToken: config.authToken,
      fromNumber: config.fromNumber,
      toNumber,
      body,
    },
    signal,
  );
}

function formatConnectPrompt(event: WhatsAppMessageEvent): string {
  const connectUrl = buildWhatsAppConnectUrl({
    phoneHandle: event.fromNumber,
    secret: env("SECRETS_ENCRYPTION_KEY"),
  });

  return [
    "To use Zero from WhatsApp, connect this phone number to your VM0 account:",
    connectUrl,
  ].join("\n");
}

function formatHelpMessage(): string {
  return [
    "Zero WhatsApp commands",
    "",
    "/connect - Connect this WhatsApp number to VM0",
    "/new_session - Start a new conversation",
    "/disconnect - Disconnect this WhatsApp number from VM0",
    "/help - Show these commands",
    "",
    "Send a message to chat with Zero after connecting.",
  ].join("\n");
}

async function sendConnectPrompt(
  event: WhatsAppMessageEvent,
  signal: AbortSignal,
): Promise<void> {
  await sendWhatsAppText(event.fromNumber, formatConnectPrompt(event), signal);
}

async function handleConnectCommand(args: {
  readonly event: WhatsAppMessageEvent;
  readonly userLink: WhatsAppUserLink | null;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.userLink) {
    await sendWhatsAppText(
      args.event.fromNumber,
      "You are already connected. Send a message here to start chatting with Zero.",
      args.signal,
    );
    return;
  }
  await sendConnectPrompt(args.event, args.signal);
}

async function handleDisconnectCommand(args: {
  readonly db: Db;
  readonly event: WhatsAppMessageEvent;
  readonly userLink: WhatsAppUserLink | null;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (!args.userLink) {
    await sendWhatsAppText(
      args.event.fromNumber,
      "Error: This WhatsApp number is not connected.",
      args.signal,
    );
    return;
  }

  await args.db
    .delete(whatsappUserLinks)
    .where(eq(whatsappUserLinks.id, args.userLink.id));
  args.signal.throwIfAborted();

  await publishWhatsAppUserChanged(args.userLink.vm0UserId);
  args.signal.throwIfAborted();

  await sendWhatsAppText(
    args.event.fromNumber,
    "This WhatsApp number has been disconnected from VM0.",
    args.signal,
  );
}

async function handleNewSessionCommand(args: {
  readonly db: Db;
  readonly event: WhatsAppMessageEvent;
  readonly userLink: WhatsAppUserLink | null;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (!args.userLink) {
    await sendConnectPrompt(args.event, args.signal);
    return;
  }

  await args.db
    .delete(whatsappThreadSessions)
    .where(
      and(
        eq(whatsappThreadSessions.whatsappUserLinkId, args.userLink.id),
        eq(whatsappThreadSessions.rootMessageId, WHATSAPP_DM_ROOT_MESSAGE_ID),
      ),
    );
  args.signal.throwIfAborted();

  await sendWhatsAppText(
    args.event.fromNumber,
    "New session started.",
    args.signal,
  );
}

async function dispatchWhatsAppCommand(args: {
  readonly db: Db;
  readonly command: string;
  readonly event: WhatsAppMessageEvent;
  readonly userLink: WhatsAppUserLink | null;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  switch (args.command) {
    case "connect": {
      await handleConnectCommand(args);
      return true;
    }
    case "disconnect": {
      await handleDisconnectCommand(args);
      return true;
    }
    case "new_session": {
      await handleNewSessionCommand(args);
      return true;
    }
    case "help": {
      await sendWhatsAppText(
        args.event.fromNumber,
        formatHelpMessage(),
        args.signal,
      );
      return true;
    }
    default: {
      return false;
    }
  }
}

function handleWhatsAppCommandIfPresent(args: {
  readonly db: Db;
  readonly event: WhatsAppMessageEvent;
  readonly userLink: WhatsAppUserLink | null;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const commandText = parseWhatsAppCommand(args.event.body);
  if (commandText === undefined) {
    return Promise.resolve(false);
  }

  return dispatchWhatsAppCommand({
    db: args.db,
    command: commandText,
    event: args.event,
    userLink: args.userLink,
    signal: args.signal,
  });
}

async function runAgentForWhatsApp(
  set: ComputedSetter,
  args: {
    readonly auth: {
      readonly tokenType: "session";
      readonly userId: string;
      readonly orgId: string;
      readonly orgRole: "member";
    };
    readonly agent: WorkspaceAgent;
    readonly sessionId: string | undefined;
    readonly prompt: string;
    readonly threadContext: string;
    readonly userInfoExtras: { readonly whatsappHandle: string };
    readonly event: WhatsAppMessageEvent;
    readonly callbackContext: WhatsAppCallbackContext;
    readonly apiStartTime: number;
    readonly modelRoute: ModelRoutePin | undefined;
  },
  signal: AbortSignal,
): Promise<RunAgentResult> {
  const result = await set(
    createZeroRun$,
    {
      auth: args.auth,
      body: {
        prompt: args.prompt,
        agentId: args.agent.agentId,
        sessionId: args.sessionId,
        ...(args.modelRoute?.modelProviderType
          ? { modelProvider: args.modelRoute.modelProviderType }
          : {}),
      },
      apiStartTime: args.apiStartTime,
      triggerSource: "whatsapp",
      appendSystemPrompt: buildWhatsAppRunPrompt(
        {
          sharedNumber: optionalEnv("TWILIO_WHATSAPP_FROM_NUMBER") ?? "",
          phoneHandle: args.event.fromNumber,
          messageSid: args.event.messageSid,
        },
        args.threadContext,
      ),
      userInfoExtras: args.userInfoExtras,
      modelProviderId: args.modelRoute?.modelProviderId ?? undefined,
      modelProviderCredentialScope:
        args.modelRoute?.modelProviderCredentialScope,
      selectedModelOverride: args.modelRoute?.selectedModel,
      callbacks: [
        {
          url: `${env("VM0_API_URL")}/api/internal/callbacks/twilio`,
          secret: randomBytes(32).toString("hex"),
          payload: args.callbackContext,
        },
      ],
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === 201) {
    return {
      status: result.body.status === "queued" ? "queued" : "accepted",
      runId: result.body.runId,
    };
  }

  return {
    status: "failed",
    response: formatRunErrorForExternalSurface({
      code: result.body.error.code,
      message: result.body.error.message,
    }),
  };
}

async function sendWhatsAppFailedRunResult(args: {
  readonly get: ComputedGetter;
  readonly event: WhatsAppMessageEvent;
  readonly userLink: WhatsAppUserLink;
  readonly result: RunAgentResult;
  readonly signal: AbortSignal;
}): Promise<void> {
  const logsUrl = args.result.runId
    ? await resolveAgentPhoneAuditLogsUrl({
        getFeatureOverrides: (orgId, userId) => {
          return args.get(userFeatureSwitchOverrides(orgId, userId));
        },
        orgId: args.userLink.orgId,
        userId: args.userLink.vm0UserId,
        runId: args.result.runId,
        signal: args.signal,
      })
    : undefined;
  args.signal.throwIfAborted();
  await sendWhatsAppText(
    args.event.fromNumber,
    [
      args.result.response ??
        "An unexpected error occurred. Please try again later.",
      logsUrl ? formatAgentPhoneAuditLink(logsUrl) : null,
    ]
      .filter((part): part is string => {
        return Boolean(part);
      })
      .join("\n\n"),
    args.signal,
  );
}

async function handleWhatsAppRunResult(args: {
  readonly get: ComputedGetter;
  readonly event: WhatsAppMessageEvent;
  readonly userLink: WhatsAppUserLink;
  readonly result: RunAgentResult;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.result.status === "queued") {
    await sendWhatsAppText(
      args.event.fromNumber,
      "Run queued because the concurrency limit was reached. It will start automatically when a slot is available.",
      args.signal,
    );
    return;
  }

  if (args.result.status === "failed") {
    await sendWhatsAppFailedRunResult(args);
  }
}

export const handleWhatsAppMessage$ = command(
  async (
    { get, set },
    params: {
      readonly event: WhatsAppMessageEvent;
      readonly userLink: WhatsAppUserLink | null;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);

    if (
      await handleWhatsAppCommandIfPresent({
        db,
        event: params.event,
        userLink: params.userLink,
        signal,
      })
    ) {
      return;
    }

    if (!params.userLink) {
      await sendConnectPrompt(params.event, signal);
      return;
    }

    const agent = await resolveWhatsAppAgent(db, params.userLink);
    signal.throwIfAborted();
    if (!agent) {
      await sendWhatsAppText(
        params.event.fromNumber,
        "The workspace default agent is not configured. Please choose an agent in VM0 first.",
        signal,
      );
      return;
    }

    const modelRoute = await resolveIntegrationModelRouteForUser({
      get,
      set,
      orgId: params.userLink.orgId,
      userId: params.userLink.vm0UserId,
      signal,
    });
    signal.throwIfAborted();

    const rootMessageId = WHATSAPP_DM_ROOT_MESSAGE_ID;
    const session = await resolveCompatibleWhatsAppThreadSession({
      db,
      userLinkId: params.userLink.id,
      userId: params.userLink.vm0UserId,
      agentComposeId: agent.composeId,
      rootMessageId,
      modelRoute,
    });
    signal.throwIfAborted();

    const { executionContext } = await fetchWhatsAppContext(db, {
      userLinkId: params.userLink.id,
      phoneHandle: params.event.fromNumber,
      currentMessageSid: params.event.messageSid,
    });
    signal.throwIfAborted();

    const { prompt, userInfoExtras } = enrichWhatsAppPrompt({
      prompt: params.event.body,
      phoneHandle: params.event.fromNumber,
      messageSid: params.event.messageSid,
      mediaUrls: params.event.mediaUrls,
    });

    const result = await runAgentForWhatsApp(
      set,
      {
        auth: {
          tokenType: "session",
          userId: params.userLink.vm0UserId,
          orgId: params.userLink.orgId,
          orgRole: "member",
        },
        agent,
        sessionId: session.existingSessionId,
        prompt,
        threadContext: executionContext,
        userInfoExtras,
        event: params.event,
        apiStartTime: params.apiStartTime,
        modelRoute,
        callbackContext: {
          messageSid: params.event.messageSid,
          rootMessageId,
          phoneHandle: params.event.fromNumber,
          fromNumber: params.event.fromNumber,
          toNumber: params.event.toNumber,
          userLinkId: params.userLink.id,
          agentId: agent.composeId,
          existingSessionId: session.existingSessionId ?? null,
        },
      },
      signal,
    );

    await handleWhatsAppRunResult({
      get,
      event: params.event,
      userLink: params.userLink,
      result,
      signal,
    });
  },
);

export function markdownToWhatsAppPlain(markdown: string): string {
  return markdownToImessagePlain(markdown);
}

export function splitWhatsAppMessageBody(body: string): readonly string[] {
  const trimmed = body.trim();
  if (trimmed.length <= WHATSAPP_MESSAGE_CHUNK_SIZE) {
    return [trimmed || "Task completed successfully."];
  }

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > WHATSAPP_MESSAGE_CHUNK_SIZE) {
    let index = remaining.lastIndexOf("\n\n", WHATSAPP_MESSAGE_CHUNK_SIZE);
    if (index < WHATSAPP_MESSAGE_CHUNK_SIZE / 2) {
      index = remaining.lastIndexOf(" ", WHATSAPP_MESSAGE_CHUNK_SIZE);
    }
    if (index < WHATSAPP_MESSAGE_CHUNK_SIZE / 2) {
      index = WHATSAPP_MESSAGE_CHUNK_SIZE;
    }
    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export async function publishWhatsAppUserChanged(
  userId: string,
): Promise<void> {
  const result = await settle(publishUserSignal([userId], "whatsapp:changed"));
  if (!result.ok) {
    log.warn("Failed to publish WhatsApp user signal", {
      userId,
      error: result.error,
    });
  }
}
