import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { command, type Getter, type Setter } from "ccstate";
import { RUN_ERROR_GUIDANCE } from "@vm0/api-contracts/contracts/errors";
import {
  getCanonicalModelDisplayName,
  getVm0VisibleModels,
  isSupportedRunModel,
  normalizeRunModelId,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  zeroIntegrationsTelegramContract,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import {
  telegramMessages,
  type TelegramMessageEntity,
} from "@vm0/db/schema/telegram-message";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";
import { telegramUserAgentPreferences } from "@vm0/db/schema/telegram-user-agent-preference";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, desc, eq } from "drizzle-orm";

import {
  buildTelegramErrorResponse,
  escapeHtml,
} from "../../lib/telegram-format";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import { publishOrgSignal } from "../external/realtime";
import { checkTelegramDomain } from "../external/telegram-domain";
import {
  getMe,
  isTelegramApiError,
  sendChatAction,
  sendMessage,
  setMyCommands,
  setWebhook,
  type TelegramReplyMarkup,
} from "../external/telegram-client";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../external/telegram-official";
import { now, nowDate } from "../external/time";
import { safeUrlParse, settle, tapError } from "../utils";
import { encryptSecretValue, decryptSecretValue } from "./crypto.utils";
import { listOrgModelPolicies$ } from "./zero-model-policy.service";
import { createZeroRun$ } from "./zero-runs-create.service";
import { telegramIntegrationBotStatus } from "./zero-telegram-data.service";
import {
  formatTelegramUserDisplayName,
  linkOfficialTelegramUserToVm0User$,
  linkTelegramUserToVm0User$,
} from "./zero-telegram-link.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "./zero-user-data.service";
import type { ApiOrgRole, AuthContext, AuthTokenType } from "../../types/auth";

const log = logger("api:telegram:post");
const MAX_CONTEXT_MESSAGES = 10;
const PENDING_TELEGRAM_USER_ID = "pending";
const QUEUED_MESSAGE =
  "Run queued - concurrency limit reached. Will start automatically when a slot is available.";

interface OrganizationAuth {
  readonly tokenType: AuthTokenType;
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole?: ApiOrgRole;
}
type ZeroRunAuth = AuthContext & { readonly orgId: string };
type TelegramInstallation = typeof telegramInstallations.$inferSelect;
type TelegramUserLink = typeof telegramUserLinks.$inferSelect;
type OfficialTelegramUserLink = typeof telegramOfficialUserLinks.$inferSelect;
type ComputedGetter = Getter;
type ComputedSetter = Setter;

interface TelegramPhotoSize {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly width: number;
  readonly height: number;
  readonly file_size?: number;
}

interface TelegramFileBase {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly file_size?: number;
}

interface TelegramDocument extends TelegramFileBase {
  readonly file_name?: string;
  readonly mime_type?: string;
}

interface TelegramVideo extends TelegramDocument {
  readonly width: number;
  readonly height: number;
  readonly duration: number;
}

interface TelegramAudio extends TelegramDocument {
  readonly duration: number;
  readonly performer?: string;
  readonly title?: string;
}

interface TelegramVoice extends TelegramFileBase {
  readonly duration: number;
  readonly mime_type?: string;
}

interface TelegramAnimation extends TelegramDocument {
  readonly width: number;
  readonly height: number;
  readonly duration: number;
}

interface TelegramVideoNote extends TelegramFileBase {
  readonly length: number;
  readonly duration: number;
}

interface TelegramSticker extends TelegramFileBase {
  readonly type?: string;
  readonly width: number;
  readonly height: number;
  readonly emoji?: string;
}

interface TelegramMessage {
  readonly message_id: number;
  readonly message_thread_id?: number;
  readonly chat: { readonly id: number; readonly type: string };
  readonly from?: {
    readonly id: number;
    readonly username?: string;
    readonly first_name?: string;
    readonly last_name?: string;
    readonly language_code?: string;
    readonly is_bot?: boolean;
  };
  readonly text?: string;
  readonly caption?: string;
  readonly photo?: readonly TelegramPhotoSize[];
  readonly document?: TelegramDocument;
  readonly video?: TelegramVideo;
  readonly audio?: TelegramAudio;
  readonly voice?: TelegramVoice;
  readonly animation?: TelegramAnimation;
  readonly video_note?: TelegramVideoNote;
  readonly sticker?: TelegramSticker;
  readonly entities?: readonly TelegramMessageEntity[];
  readonly caption_entities?: readonly TelegramMessageEntity[];
  readonly reply_to_message?: {
    readonly message_id: number;
    readonly from?: {
      readonly id: number;
      readonly is_bot?: boolean;
      readonly username?: string;
      readonly first_name?: string;
    };
    readonly text?: string;
    readonly caption?: string;
  };
}

interface TelegramWebhookUpdate {
  readonly update_id?: number;
  readonly message?: TelegramMessage;
}

type TelegramMessageScope =
  | { readonly kind: "custom"; readonly installationId: string }
  | {
      readonly kind: "official";
      readonly orgId: string;
      readonly userLinkId: string | null;
    };

interface TelegramFileContext {
  readonly file_id: string;
  readonly file_type:
    | "photo"
    | "document"
    | "video"
    | "audio"
    | "voice"
    | "animation"
    | "video_note"
    | "sticker";
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
}

interface WorkspaceAgent {
  readonly composeId: string;
  readonly agentId: string;
  readonly name: string;
  readonly displayName: string | null;
}

interface RunAgentParams {
  readonly auth: ZeroRunAuth;
  readonly agentId: string;
  readonly sessionId: string | undefined;
  readonly prompt: string;
  readonly appendSystemPrompt: string | undefined;
  readonly userInfoExtras: TelegramUserInfoExtras;
  readonly callbackPayload: TelegramCallbackPayload;
  readonly apiStartTime: number;
  readonly selectedModelOverride: string | undefined;
}

interface TelegramCallbackPayload {
  readonly installationId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly rootMessageId: string | null;
  readonly userLinkId: string;
  readonly agentId: string;
  readonly existingSessionId: string | null;
  readonly isDM: boolean;
}

interface TelegramUserInfoExtras {
  readonly telegramDisplayName?: string;
  readonly telegramUsername?: string;
  readonly telegramUserId?: string;
  readonly telegramLanguage?: string;
}

interface RunAgentResult {
  readonly status: "accepted" | "queued" | "failed";
  readonly response?: string;
  readonly runId?: string;
}

interface TelegramThreadLookupResult {
  readonly existingSessionId: string | undefined;
  readonly lastProcessedMessageId: string | undefined;
}

function apiError<Status extends 400 | 403 | 404 | 409 | 500 | 502>(
  status: Status,
  message: string,
  code:
    | "BAD_REQUEST"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "CONFLICT"
    | "INTERNAL"
    | "BAD_GATEWAY",
) {
  return {
    status,
    body: { error: { message, code } },
  };
}

function badRequest(message: string) {
  return apiError(400, message, "BAD_REQUEST");
}

function forbidden(message: string) {
  return apiError(403, message, "FORBIDDEN");
}

function notFound(message: string) {
  return apiError(404, message, "NOT_FOUND");
}

function conflict(message: string) {
  return apiError(409, message, "CONFLICT");
}

function internalError(message: string) {
  return apiError(500, message, "INTERNAL");
}

function badGateway(message: string) {
  return apiError(502, message, "BAD_GATEWAY");
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function okText(): Response {
  return textResponse("OK", 200);
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function buildTelegramWebhookUrl(telegramBotId: string): string {
  return `${env("VM0_WEB_URL")}/api/telegram/webhook/${telegramBotId}`;
}

function normalizeTelegramUsername(
  telegramUsername: string | null | undefined,
): string | null {
  const value = telegramUsername?.trim().replace(/^@+/, "");
  return value || null;
}

function normalizeTelegramDisplayName(
  telegramDisplayName: string | null | undefined,
): string | null {
  const value = telegramDisplayName?.trim().replace(/\s+/g, " ");
  return value ? value.slice(0, 255) : null;
}

function displayLabel(row: {
  readonly displayName: string | null;
  readonly name: string | null;
}): string {
  return row.displayName?.trim() || row.name?.trim() || "Zero";
}

async function getWorkspaceAgent(
  db: Db,
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

async function getWorkspaceAgentDisplayLabel(
  db: Db,
  composeId: string,
): Promise<string> {
  const agent = await getWorkspaceAgent(db, composeId);
  return agent ? displayLabel(agent) : "Zero";
}

async function resolveDefaultAgentId(args: {
  readonly db: Db;
  readonly requestedAgentId: string | undefined;
  readonly fallbackAgentId: string | undefined;
  readonly orgId: string;
}): Promise<
  | { readonly ok: true; readonly agentId: string }
  | ReturnType<typeof badRequest>
  | ReturnType<typeof forbidden>
  | ReturnType<typeof notFound>
> {
  let defaultAgentId = args.requestedAgentId ?? args.fallbackAgentId;
  if (!defaultAgentId) {
    const [metadata] = await args.db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    defaultAgentId = metadata?.defaultAgentId ?? undefined;
  }

  if (!defaultAgentId) {
    return badRequest(
      "No default agent specified. Provide defaultAgentId or configure a default agent for the active organization.",
    );
  }

  const [compose] = await args.db
    .select({ id: agentComposes.id, orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, defaultAgentId))
    .limit(1);

  if (!compose) {
    return notFound("Agent not found");
  }
  if (compose.orgId !== args.orgId) {
    return forbidden(
      "Telegram bots can only be connected to agents in the active organization.",
    );
  }

  return { ok: true, agentId: compose.id };
}

async function configureTelegramBot(args: {
  readonly botToken: string;
  readonly telegramBotId: string;
  readonly webhookSecret: string;
  readonly agentName: string;
}): Promise<ReturnType<typeof badGateway> | undefined> {
  const webhookResult = await settle(
    setWebhook(
      args.botToken,
      buildTelegramWebhookUrl(args.telegramBotId),
      args.webhookSecret,
    ),
  );
  if (!webhookResult.ok) {
    log.error("Failed to set Telegram webhook", {
      error: webhookResult.error,
    });
    return badGateway("Failed to register webhook with Telegram");
  }

  const commandsResult = await settle(
    setMyCommands(args.botToken, [
      { command: "new_session", description: "Start a new conversation" },
      { command: "connect", description: `Connect to ${args.agentName}` },
      { command: "model", description: "Choose your model" },
      {
        command: "disconnect",
        description: `Disconnect from ${args.agentName}`,
      },
      { command: "help", description: "Show available commands" },
    ]),
  );
  if (!commandsResult.ok) {
    log.warn("Failed to register Telegram bot commands", {
      error: commandsResult.error,
    });
  }

  return undefined;
}

async function publishTelegramOrgChanged(orgId: string): Promise<void> {
  await tapError(publishOrgSignal(orgId, "telegram:changed"), (error) => {
    log.warn("Failed to publish Telegram org change", { error });
  });
}

async function buildStatusResponse(
  get: ComputedGetter,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly botId: string;
  },
) {
  const status = await get(
    telegramIntegrationBotStatus({
      orgId: args.orgId,
      userId: args.userId,
      botId: args.botId,
    }),
  );
  return status
    ? { status: 200 as const, body: status }
    : notFound("Telegram bot not found");
}

async function handleExistingInstallation(args: {
  readonly get: ComputedGetter;
  readonly db: Db;
  readonly existing: TelegramInstallation;
  readonly body: {
    readonly botToken: string;
    readonly defaultAgentId?: string;
    readonly reinstallBotId?: string;
  };
  readonly botInfo: { readonly username: string };
  readonly auth: OrganizationAuth;
  readonly signal: AbortSignal;
}) {
  if (!args.body.reinstallBotId) {
    return conflict(
      `This bot is already installed. Use /connect in Telegram (@${
        args.existing.botUsername ?? args.existing.telegramBotId
      }) to link your account.`,
    );
  }

  if (args.existing.orgId !== args.auth.orgId) {
    return conflict(
      "This Telegram bot is already installed in another workspace.",
    );
  }

  if (
    args.existing.ownerUserId !== args.auth.userId &&
    args.auth.orgRole !== "admin"
  ) {
    return forbidden(
      "Only the bot owner or an org admin can reinstall this bot",
    );
  }

  const resolvedAgent = await resolveDefaultAgentId({
    db: args.db,
    requestedAgentId: args.body.defaultAgentId,
    fallbackAgentId: args.existing.defaultComposeId,
    orgId: args.auth.orgId,
  });
  args.signal.throwIfAborted();
  if (!("ok" in resolvedAgent)) {
    return resolvedAgent;
  }

  const webhookSecret = generateCallbackSecret();
  const agentName = await getWorkspaceAgentDisplayLabel(
    args.db,
    resolvedAgent.agentId,
  );
  args.signal.throwIfAborted();
  const configureError = await configureTelegramBot({
    botToken: args.body.botToken,
    telegramBotId: args.existing.telegramBotId,
    webhookSecret,
    agentName,
  });
  args.signal.throwIfAborted();
  if (configureError) {
    return configureError;
  }

  const [updated] = await args.db
    .update(telegramInstallations)
    .set({
      botUsername: args.botInfo.username,
      encryptedBotToken: encryptSecretValue(args.body.botToken),
      webhookSecret,
      defaultComposeId: resolvedAgent.agentId,
      updatedAt: nowDate(),
    })
    .where(eq(telegramInstallations.telegramBotId, args.existing.telegramBotId))
    .returning();
  args.signal.throwIfAborted();

  await publishTelegramOrgChanged(args.auth.orgId);
  args.signal.throwIfAborted();

  return buildStatusResponse(args.get, {
    orgId: args.auth.orgId,
    userId: args.auth.userId,
    botId: updated?.telegramBotId ?? args.existing.telegramBotId,
  });
}

function registerBodyError(message: string): ReturnType<typeof badRequest> {
  return badRequest(
    message.includes("defaultAgentId")
      ? "defaultAgentId must be non-empty"
      : "botToken is required",
  );
}

export const registerTelegramBot$ = command(
  async ({ get, set }, auth: OrganizationAuth, signal: AbortSignal) => {
    const bodyResult = await get(
      bodyResultOf(zeroIntegrationsTelegramContract.register),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return registerBodyError(bodyResult.response.body.error.message);
    }

    const botInfoResult = await settle(getMe(bodyResult.data.botToken));
    signal.throwIfAborted();
    if (!botInfoResult.ok) {
      return badRequest(
        "Invalid bot token. Please verify your token with @BotFather.",
      );
    }

    const db = set(writeDb$);
    const telegramBotId = String(botInfoResult.value.id);
    if (
      bodyResult.data.reinstallBotId &&
      bodyResult.data.reinstallBotId !== telegramBotId
    ) {
      return badRequest(
        "This token belongs to a different Telegram bot. Paste the token for the selected bot.",
      );
    }

    const [existing] = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, telegramBotId))
      .limit(1);
    signal.throwIfAborted();

    if (existing) {
      return handleExistingInstallation({
        get,
        db,
        existing,
        body: bodyResult.data,
        botInfo: botInfoResult.value,
        auth,
        signal,
      });
    }

    if (bodyResult.data.reinstallBotId) {
      return notFound("Telegram bot not found");
    }

    const resolvedAgent = await resolveDefaultAgentId({
      db,
      requestedAgentId: bodyResult.data.defaultAgentId,
      fallbackAgentId: undefined,
      orgId: auth.orgId,
    });
    signal.throwIfAborted();
    if (!("ok" in resolvedAgent)) {
      return resolvedAgent;
    }

    const webhookSecret = generateCallbackSecret();
    const [installation] = await db
      .insert(telegramInstallations)
      .values({
        telegramBotId,
        botUsername: botInfoResult.value.username,
        encryptedBotToken: encryptSecretValue(bodyResult.data.botToken),
        webhookSecret,
        defaultComposeId: resolvedAgent.agentId,
        ownerUserId: auth.userId,
        orgId: auth.orgId,
      })
      .returning();
    signal.throwIfAborted();
    if (!installation) {
      return internalError("Failed to create installation");
    }

    const agentName = await getWorkspaceAgentDisplayLabel(
      db,
      resolvedAgent.agentId,
    );
    signal.throwIfAborted();
    const configureError = await configureTelegramBot({
      botToken: bodyResult.data.botToken,
      telegramBotId: installation.telegramBotId,
      webhookSecret,
      agentName,
    });
    signal.throwIfAborted();
    if (configureError) {
      await db
        .delete(telegramInstallations)
        .where(
          eq(telegramInstallations.telegramBotId, installation.telegramBotId),
        );
      signal.throwIfAborted();
      return configureError;
    }

    await publishTelegramOrgChanged(auth.orgId);
    signal.throwIfAborted();

    const status = await get(
      telegramIntegrationBotStatus({
        orgId: auth.orgId,
        userId: auth.userId,
        botId: installation.telegramBotId,
      }),
    );
    signal.throwIfAborted();

    return status
      ? { status: 201 as const, body: status }
      : internalError("Failed to create installation");
  },
);

function resolveProbeOrigin(origin: string | undefined): string {
  if (!origin) {
    return env("VM0_WEB_URL");
  }

  const parsed = safeUrlParse(origin);
  if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return parsed.origin;
  }

  return env("VM0_WEB_URL");
}

function isInvalidTelegramTokenError(error: unknown): boolean {
  return (
    isTelegramApiError(error) &&
    (error.status === 401 ||
      /unauthorized|not found/i.test(error.description ?? ""))
  );
}

export const setupTelegramStatus$ = command(
  async ({ get, set }, auth: OrganizationAuth, signal: AbortSignal) => {
    const bodyResult = await get(
      bodyResultOf(zeroIntegrationsTelegramContract.setupStatus),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return badRequest("botToken is required");
    }

    const botInfoResult = await settle(getMe(bodyResult.data.botToken));
    signal.throwIfAborted();
    if (!botInfoResult.ok) {
      if (!isInvalidTelegramTokenError(botInfoResult.error)) {
        log.warn("Unable to verify Telegram setup status", {
          error: botInfoResult.error,
        });
      }
      return badRequest(
        "Invalid bot token. Please verify your token with @BotFather.",
      );
    }

    const botId = String(botInfoResult.value.id);
    const db = set(writeDb$);
    const [existing] = await db
      .select({
        orgId: telegramInstallations.orgId,
        botUsername: telegramInstallations.botUsername,
      })
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, botId))
      .limit(1);
    signal.throwIfAborted();

    if (existing) {
      return conflict(
        existing.orgId === auth.orgId
          ? `This bot is already installed. Use /connect in Telegram (@${
              existing.botUsername ?? botId
            }) to link your account.`
          : "This Telegram bot is already installed in another workspace.",
      );
    }

    const domainConfigured = await checkTelegramDomain(
      botId,
      resolveProbeOrigin(bodyResult.data.origin),
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        id: botId,
        username: botInfoResult.value.username ?? null,
        domainConfigured,
        privacyDisabled:
          botInfoResult.value.can_read_all_group_messages === true,
      },
    };
  },
);

function verifyTelegramWebhook(
  request: Request,
  expectedSecret: string,
): boolean {
  const token = request.headers.get("x-telegram-bot-api-secret-token");
  if (!token) {
    return false;
  }

  const tokenBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expectedSecret);
  return (
    tokenBuffer.length === expectedBuffer.length &&
    timingSafeEqual(tokenBuffer, expectedBuffer)
  );
}

function isTelegramUpdate(value: unknown): value is TelegramWebhookUpdate {
  return typeof value === "object" && value !== null;
}

function messageText(message: TelegramMessage): string {
  return message.text ?? message.caption ?? "";
}

function extractEntities(
  message: TelegramMessage,
): readonly TelegramMessageEntity[] | undefined {
  const entities = [
    ...(message.entities ?? []),
    ...(message.caption_entities ?? []),
  ];
  return entities.length > 0 ? entities : undefined;
}

function selectLargestPhoto(
  photos: readonly TelegramPhotoSize[] | undefined,
): TelegramPhotoSize | undefined {
  return photos?.reduce<TelegramPhotoSize | undefined>((largest, photo) => {
    if (!largest) {
      return photo;
    }
    return photo.width * photo.height > largest.width * largest.height
      ? photo
      : largest;
  }, undefined);
}

function extractTelegramFileForContext(
  message: TelegramMessage,
): TelegramFileContext | undefined {
  const photo = selectLargestPhoto(message.photo);
  if (photo) {
    return {
      file_id: photo.file_id,
      file_type: "photo",
      file_size: photo.file_size,
      width: photo.width,
      height: photo.height,
    };
  }
  if (message.document) {
    return {
      file_id: message.document.file_id,
      file_type: "document",
      file_name: message.document.file_name,
      mime_type: message.document.mime_type,
      file_size: message.document.file_size,
    };
  }
  if (message.video) {
    return {
      file_id: message.video.file_id,
      file_type: "video",
      file_name: message.video.file_name,
      mime_type: message.video.mime_type,
      file_size: message.video.file_size,
      width: message.video.width,
      height: message.video.height,
      duration: message.video.duration,
    };
  }
  if (message.audio) {
    return {
      file_id: message.audio.file_id,
      file_type: "audio",
      file_name: message.audio.file_name,
      mime_type: message.audio.mime_type,
      file_size: message.audio.file_size,
      duration: message.audio.duration,
    };
  }
  if (message.voice) {
    return {
      file_id: message.voice.file_id,
      file_type: "voice",
      mime_type: message.voice.mime_type,
      file_size: message.voice.file_size,
      duration: message.voice.duration,
    };
  }
  if (message.animation) {
    return {
      file_id: message.animation.file_id,
      file_type: "animation",
      file_name: message.animation.file_name,
      mime_type: message.animation.mime_type,
      file_size: message.animation.file_size,
      width: message.animation.width,
      height: message.animation.height,
      duration: message.animation.duration,
    };
  }
  if (message.video_note) {
    return {
      file_id: message.video_note.file_id,
      file_type: "video_note",
      file_size: message.video_note.file_size,
      width: message.video_note.length,
      height: message.video_note.length,
      duration: message.video_note.duration,
    };
  }
  if (message.sticker) {
    return {
      file_id: message.sticker.file_id,
      file_type: "sticker",
      file_size: message.sticker.file_size,
      width: message.sticker.width,
      height: message.sticker.height,
    };
  }
  return undefined;
}

function hasTelegramMessageContextContent(message: TelegramMessage): boolean {
  return Boolean(
    message.text ||
    message.caption ||
    extractTelegramFileForContext(message) ||
    extractEntities(message),
  );
}

function telegramFileDbValues(file: TelegramFileContext | undefined): {
  readonly fileId: string | null;
  readonly fileType: string | null;
  readonly fileName: string | null;
  readonly fileMimeType: string | null;
  readonly fileSize: number | null;
  readonly fileWidth: number | null;
  readonly fileHeight: number | null;
  readonly fileDuration: number | null;
} {
  return {
    fileId: file?.file_id ?? null,
    fileType: file?.file_type ?? null,
    fileName: file?.file_name ?? null,
    fileMimeType: file?.mime_type ?? null,
    fileSize: file?.file_size ?? null,
    fileWidth: file?.width ?? null,
    fileHeight: file?.height ?? null,
    fileDuration: file?.duration ?? null,
  };
}

async function storeTelegramMessage(args: {
  readonly db: Db;
  readonly scope: TelegramMessageScope;
  readonly chatId: string;
  readonly message: TelegramMessage;
}): Promise<void> {
  const file = extractTelegramFileForContext(args.message);
  await args.db
    .insert(telegramMessages)
    .values({
      installationId:
        args.scope.kind === "custom" ? args.scope.installationId : null,
      officialOrgId: args.scope.kind === "official" ? args.scope.orgId : null,
      officialUserLinkId:
        args.scope.kind === "official" ? args.scope.userLinkId : null,
      chatId: args.chatId,
      messageId: String(args.message.message_id),
      fromUserId: String(args.message.from?.id ?? 0),
      fromUsername: args.message.from?.username ?? null,
      fromDisplayName: formatTelegramUserDisplayName(args.message.from ?? {}),
      text: args.message.text ?? args.message.caption ?? null,
      ...telegramFileDbValues(file),
      entities: extractEntities(args.message)
        ? [...extractEntities(args.message)!]
        : null,
      isBot: args.message.from?.is_bot ?? false,
    })
    .onConflictDoNothing();
}

function formatTelegramFileForContext(
  file: TelegramFileContext,
  botId: string,
): string {
  const details = [
    `type=${file.file_type}`,
    file.file_name ? `name=${file.file_name}` : null,
    file.mime_type ? `mime=${file.mime_type}` : null,
    file.file_size ? `size=${file.file_size}` : null,
    file.width && file.height
      ? `dimensions=${file.width}x${file.height}`
      : null,
    file.duration ? `duration=${file.duration}s` : null,
  ].filter((part): part is string => {
    return part !== null;
  });
  return `[Telegram file]\n   [BOT_ID] ${botId}\n   [FILE_ID] ${file.file_id}\n   [DETAILS] ${details.join(", ")}`;
}

function appendTelegramMessageContext(
  prompt: string,
  message: TelegramMessage,
  botId: string,
): string {
  const file = extractTelegramFileForContext(message);
  if (!file) {
    return prompt;
  }
  const fileContext = formatTelegramFileForContext(file, botId);
  return prompt ? `${prompt}\n\n${fileContext}` : fileContext;
}

function formatReplyQuote(
  replyMessage: TelegramMessage["reply_to_message"],
): string | undefined {
  const replyText = replyMessage?.text ?? replyMessage?.caption;
  if (!replyText) {
    return undefined;
  }
  const sender = replyMessage?.from?.username
    ? `@${replyMessage.from.username}`
    : (replyMessage?.from?.first_name ?? "Unknown");
  return `[Replying to ${sender}]\n> ${replyText}`;
}

function enrichTelegramPrompt(message: TelegramMessage): {
  readonly prompt: string;
  readonly userInfoExtras: TelegramUserInfoExtras;
} {
  const from = message.from;
  return {
    prompt: message.text ?? message.caption ?? "",
    userInfoExtras: from
      ? {
          telegramDisplayName: formatTelegramUserDisplayName(from) ?? undefined,
          telegramUsername: from.username ? `@${from.username}` : undefined,
          telegramUserId: String(from.id),
          telegramLanguage: from.language_code,
        }
      : {},
  };
}

function normalizedBotUsername(botUsername: string | null | undefined): string {
  return botUsername?.replace(/^@/, "").trim() ?? "";
}

function isTelegramReplyToBotUsername(
  message: TelegramMessage,
  botUsername: string | null | undefined,
): boolean {
  const username = normalizedBotUsername(botUsername).toLowerCase();
  if (!username) {
    return false;
  }
  const replyFrom = message.reply_to_message?.from;
  if (replyFrom?.is_bot !== true) {
    return false;
  }
  return normalizedBotUsername(replyFrom.username).toLowerCase() === username;
}

function parseBotCommand(
  text: string | undefined,
  botUsername: string | null,
): string | undefined {
  if (!text?.startsWith("/")) {
    return undefined;
  }
  const firstWord = text.split(/\s/u)[0];
  if (!firstWord) {
    return undefined;
  }
  const atIndex = firstWord.indexOf("@");
  if (atIndex === -1) {
    return firstWord.slice(1).toLowerCase();
  }
  const targetUsername = firstWord.slice(atIndex + 1);
  if (
    botUsername &&
    targetUsername.toLowerCase() === botUsername.toLowerCase()
  ) {
    return firstWord.slice(1, atIndex).toLowerCase();
  }
  return undefined;
}

function stripBotMention(text: string, botUsername: string | null): string {
  if (!botUsername) {
    return text;
  }
  const mention = `@${botUsername}`;
  const mentionLower = mention.toLowerCase();
  const lower = text.toLowerCase();
  let result = "";
  let cursor = 0;
  for (;;) {
    const idx = lower.indexOf(mentionLower, cursor);
    if (idx === -1) {
      result += text.slice(cursor);
      break;
    }
    result += text.slice(cursor, idx).trimEnd();
    result += " ";
    cursor = idx + mention.length;
    while (cursor < text.length && /\s/u.test(text.charAt(cursor))) {
      cursor += 1;
    }
  }
  return result.trim();
}

function hasBotMention(
  message: TelegramMessage,
  botUsername: string | null,
): boolean {
  if (!botUsername) {
    return false;
  }
  const source = messageText(message);
  return (extractEntities(message) ?? []).some((entity) => {
    return (
      entity.type === "mention" &&
      source
        .slice(entity.offset, entity.offset + entity.length)
        .toLowerCase() === `@${botUsername.toLowerCase()}`
    );
  });
}

function signConnectParams(args: {
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly timestamp: number;
  readonly botToken: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
}): string {
  const username = normalizeTelegramUsername(args.telegramUsername);
  const displayName = normalizeTelegramDisplayName(args.telegramDisplayName);
  let data = `${args.installationId}:${args.telegramUserId}:${args.timestamp}`;
  if (username || displayName) {
    data += `:${username ?? ""}`;
  }
  if (displayName) {
    data += `:${displayName}`;
  }
  return createHmac("sha256", args.botToken).update(data).digest("hex");
}

function buildConnectUrl(args: {
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly botToken: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
}): string {
  const timestamp = Math.floor(now() / 1000);
  const params = new URLSearchParams({
    bot: args.installationId,
    tgUser: args.telegramUserId,
    ts: String(timestamp),
    sig: signConnectParams({ ...args, timestamp }),
  });
  const username = normalizeTelegramUsername(args.telegramUsername);
  const displayName = normalizeTelegramDisplayName(args.telegramDisplayName);
  if (username) {
    params.set("tgUserName", username);
  }
  if (displayName) {
    params.set("tgDisplayName", displayName);
  }
  return `${env("VM0_WEB_URL")}/telegram/connect?${params.toString()}`;
}

function buildTelegramConnectReplyMarkup(connectUrl: string) {
  return { inline_keyboard: [[{ text: "Connect", url: connectUrl }]] };
}

function buildTelegramPrivateConnectReplyMarkup(botUsername: string | null) {
  const username = normalizedBotUsername(botUsername);
  return username
    ? buildTelegramConnectReplyMarkup(
        `https://t.me/${encodeURIComponent(username)}?start=connect`,
      )
    : undefined;
}

function formatTelegramCommandSuccess(message: string): string {
  return `✅ ${escapeHtml(message)}`;
}

function formatTelegramCommandError(message: string): string {
  return `❌ <b>Error</b>\n${escapeHtml(message)}`;
}

function formatTelegramConnectPrompt(agentName: string): string {
  return `To use ${escapeHtml(agentName)} in Telegram, please connect your account first.`;
}

function formatTelegramPrivateConnectPrompt(
  botUsername: string | null,
  agentName: string,
): string {
  const username = normalizedBotUsername(botUsername);
  if (!username) {
    return `${formatTelegramConnectPrompt(agentName)}\n\nSend me /connect in a private message.`;
  }
  return formatTelegramConnectPrompt(agentName);
}

function formatTelegramAlreadyConnectedMessage(
  botUsername: string | null,
  agentName: string,
): string {
  const username = normalizedBotUsername(botUsername);
  const target = username
    ? `Mention @${username} in a group or send a DM`
    : "Send a DM";
  return `You are already connected.\n${target} to start chatting with ${agentName}.`;
}

function formatTelegramHelpMessage(
  botUsername: string | null,
  agentName: string,
): string {
  const username = normalizedBotUsername(botUsername);
  const label = escapeHtml(agentName);
  const groupUsage = username
    ? `• <code>@${escapeHtml(username)} &lt;message&gt;</code> - Send a message to ${label}\n`
    : "";

  return [
    `<b>${label} Telegram Bot Help</b>`,
    "",
    "<b>Commands</b>",
    `• <code>/connect</code> - Connect to ${label}`,
    "• <code>/new_session</code> - Start a new conversation",
    "• <code>/model</code> - Choose your model",
    `• <code>/disconnect</code> - Disconnect from ${label}`,
    "",
    "<b>Usage</b>",
    `${groupUsage}• Send a DM to chat with ${label}`,
  ].join("\n");
}

async function postTelegramMessage(args: {
  readonly botToken: string;
  readonly chatId: string;
  readonly text: string;
  readonly replyToMessageId?: number;
  readonly replyMarkup?: TelegramReplyMarkup;
}): Promise<void> {
  const result = await tapError(
    sendMessage(args.botToken, args.chatId, args.text, {
      replyToMessageId: args.replyToMessageId,
      replyMarkup: args.replyMarkup,
    }),
    (error) => {
      log.warn("Failed to send Telegram message", {
        chatId: args.chatId,
        error,
      });
    },
  );
  if (result?.kind === "telegram-error") {
    log.warn("Telegram rejected message", {
      chatId: args.chatId,
      status: result.status,
      description: result.description,
    });
  }
}

async function sendTypingActionSafely(
  botToken: string,
  chatId: string,
): Promise<void> {
  await tapError(sendChatAction(botToken, chatId, "typing"), (error) => {
    log.debug("Failed to send Telegram typing action", {
      chatId,
      error,
    });
  });
}

async function resolveUserLink(args: {
  readonly set: ComputedSetter;
  readonly db: Db;
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
  readonly signal: AbortSignal;
}): Promise<TelegramUserLink | null> {
  const [direct] = await args.db
    .select()
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.telegramUserId, args.telegramUserId),
        eq(telegramUserLinks.installationId, args.installationId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();

  if (direct) {
    const linked = await args.set(
      linkTelegramUserToVm0User$,
      {
        installationId: args.installationId,
        telegramUserId: args.telegramUserId,
        telegramUsername: args.telegramUsername,
        telegramDisplayName: args.telegramDisplayName,
        vm0UserId: direct.vm0UserId,
      },
      args.signal,
    );
    args.signal.throwIfAborted();
    return linked.ok ? linked.userLink : direct;
  }

  const [pending] = await args.db
    .select()
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, args.installationId),
        eq(telegramUserLinks.telegramUserId, PENDING_TELEGRAM_USER_ID),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!pending) {
    return null;
  }

  const completed = await args.set(
    linkTelegramUserToVm0User$,
    {
      installationId: args.installationId,
      telegramUserId: args.telegramUserId,
      telegramUsername: args.telegramUsername,
      telegramDisplayName: args.telegramDisplayName,
      vm0UserId: pending.vm0UserId,
    },
    args.signal,
  );
  args.signal.throwIfAborted();
  return completed.ok ? completed.userLink : null;
}

async function resolveOfficialUserLink(args: {
  readonly set: ComputedSetter;
  readonly db: Db;
  readonly telegramUserId: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
  readonly signal: AbortSignal;
}): Promise<OfficialTelegramUserLink | null> {
  const [direct] = await args.db
    .select()
    .from(telegramOfficialUserLinks)
    .where(eq(telegramOfficialUserLinks.telegramUserId, args.telegramUserId))
    .limit(1);
  args.signal.throwIfAborted();
  if (!direct) {
    return null;
  }

  const linked = await args.set(
    linkOfficialTelegramUserToVm0User$,
    {
      telegramUserId: args.telegramUserId,
      telegramUsername: args.telegramUsername,
      telegramDisplayName: args.telegramDisplayName,
      vm0UserId: direct.vm0UserId,
      orgId: direct.orgId,
    },
    args.signal,
  );
  args.signal.throwIfAborted();
  return linked.ok ? linked.userLink : direct;
}

async function sendConnectPrompt(args: {
  readonly botToken: string;
  readonly botId: string;
  readonly botUsername: string | null;
  readonly chatId: string;
  readonly chatType: string;
  readonly fromUserId: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
  readonly agentName: string;
  readonly replyToMessageId?: number;
}): Promise<void> {
  if (args.chatType !== "private") {
    await postTelegramMessage({
      botToken: args.botToken,
      chatId: args.chatId,
      text: formatTelegramPrivateConnectPrompt(
        args.botUsername,
        args.agentName,
      ),
      replyToMessageId: args.replyToMessageId,
      replyMarkup: buildTelegramPrivateConnectReplyMarkup(args.botUsername),
    });
    return;
  }

  const connectUrl = buildConnectUrl({
    installationId: args.botId,
    telegramUserId: args.fromUserId,
    botToken: args.botToken,
    telegramUsername: args.telegramUsername,
    telegramDisplayName: args.telegramDisplayName,
  });
  await postTelegramMessage({
    botToken: args.botToken,
    chatId: args.chatId,
    text: formatTelegramConnectPrompt(args.agentName),
    replyMarkup: buildTelegramConnectReplyMarkup(connectUrl),
  });
}

async function lookupTelegramThreadSession(args: {
  readonly db: Db;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly userLinkId: string;
  readonly userLinkKind: "custom" | "official";
  readonly userId: string;
  readonly composeId: string;
}): Promise<{
  readonly existingSessionId: string | undefined;
  readonly lastProcessedMessageId: string | undefined;
}> {
  const [thread] = await args.db
    .select({
      agentSessionId: telegramThreadSessions.agentSessionId,
      lastProcessedMessageId: telegramThreadSessions.lastProcessedMessageId,
    })
    .from(telegramThreadSessions)
    .where(
      and(
        args.userLinkKind === "custom"
          ? eq(telegramThreadSessions.telegramUserLinkId, args.userLinkId)
          : eq(
              telegramThreadSessions.telegramOfficialUserLinkId,
              args.userLinkId,
            ),
        eq(telegramThreadSessions.chatId, args.chatId),
        eq(telegramThreadSessions.rootMessageId, args.rootMessageId),
      ),
    )
    .limit(1);

  if (!thread) {
    return { existingSessionId: undefined, lastProcessedMessageId: undefined };
  }

  const [session] = await args.db
    .select({ agentComposeId: agentSessions.agentComposeId })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, thread.agentSessionId),
        eq(agentSessions.userId, args.userId),
      ),
    )
    .limit(1);
  if (session?.agentComposeId !== args.composeId) {
    return { existingSessionId: undefined, lastProcessedMessageId: undefined };
  }

  return {
    existingSessionId: thread.agentSessionId,
    lastProcessedMessageId: thread.lastProcessedMessageId ?? undefined,
  };
}

function formatContextMessage(args: {
  readonly row: {
    readonly fromUsername: string | null;
    readonly fromDisplayName: string | null;
    readonly fromUserId: string;
    readonly text: string | null;
    readonly fileId: string | null;
    readonly fileType: string | null;
    readonly fileName: string | null;
    readonly fileMimeType: string | null;
    readonly fileSize: number | null;
    readonly fileWidth: number | null;
    readonly fileHeight: number | null;
    readonly fileDuration: number | null;
    readonly isBot: boolean;
    readonly messageId: string;
  };
  readonly relativeIndex: number;
  readonly botId: string;
}): string {
  const senderParts = args.row.isBot
    ? ["id: BOT"]
    : [`id: ${args.row.fromUserId}`];
  if (!args.row.isBot && args.row.fromUsername) {
    senderParts.push(`username: @${args.row.fromUsername}`);
  }
  if (!args.row.isBot && args.row.fromDisplayName) {
    senderParts.push(`name: ${args.row.fromDisplayName}`);
  }

  const parts = [
    "---",
    "",
    `- RELATIVE_INDEX: ${args.relativeIndex}`,
    `- MSG_ID: ${args.row.messageId}`,
    `- SENDER: {${senderParts.join(", ")}}`,
    "",
    args.row.text ?? "",
  ];
  if (args.row.fileId) {
    parts.push(
      formatTelegramFileForContext(
        {
          file_id: args.row.fileId,
          file_type: normalizeTelegramContextFileType(args.row.fileType),
          file_name: args.row.fileName ?? undefined,
          mime_type: args.row.fileMimeType ?? undefined,
          file_size: args.row.fileSize ?? undefined,
          width: args.row.fileWidth ?? undefined,
          height: args.row.fileHeight ?? undefined,
          duration: args.row.fileDuration ?? undefined,
        },
        args.botId,
      ),
    );
  }
  return parts.join("\n");
}

function normalizeTelegramContextFileType(
  fileType: string | null,
): TelegramFileContext["file_type"] {
  switch (fileType) {
    case "document":
    case "video":
    case "audio":
    case "voice":
    case "animation":
    case "video_note":
    case "sticker": {
      return fileType;
    }
    default: {
      return "photo";
    }
  }
}

async function fetchTelegramContext(args: {
  readonly db: Db;
  readonly scope: TelegramMessageScope;
  readonly chatId: string;
  readonly currentMessageId: string;
  readonly botId: string;
}): Promise<string> {
  const rows = await args.db
    .select({
      fromUsername: telegramMessages.fromUsername,
      fromDisplayName: telegramMessages.fromDisplayName,
      fromUserId: telegramMessages.fromUserId,
      text: telegramMessages.text,
      fileId: telegramMessages.fileId,
      fileType: telegramMessages.fileType,
      fileName: telegramMessages.fileName,
      fileMimeType: telegramMessages.fileMimeType,
      fileSize: telegramMessages.fileSize,
      fileWidth: telegramMessages.fileWidth,
      fileHeight: telegramMessages.fileHeight,
      fileDuration: telegramMessages.fileDuration,
      isBot: telegramMessages.isBot,
      messageId: telegramMessages.messageId,
    })
    .from(telegramMessages)
    .where(
      and(
        args.scope.kind === "custom"
          ? eq(telegramMessages.installationId, args.scope.installationId)
          : eq(telegramMessages.officialOrgId, args.scope.orgId),
        eq(telegramMessages.chatId, args.chatId),
      ),
    )
    .orderBy(desc(telegramMessages.createdAt))
    .limit(MAX_CONTEXT_MESSAGES);

  const chronological = rows.reverse().filter((row) => {
    return row.messageId !== args.currentMessageId;
  });
  if (chronological.length === 0) {
    return "";
  }

  const total = chronological.length;
  const blocks = chronological.map((row, index) => {
    return formatContextMessage({
      row,
      relativeIndex: index - total,
      botId: args.botId,
    });
  });

  return [
    "# Telegram Chat Context",
    "",
    "The messages below are from a Telegram conversation. Messages closer to RELATIVE_INDEX 0 are more recent.",
    "",
    blocks.join("\n\n"),
    "",
    "---",
  ].join("\n");
}

function buildTelegramPrompt(
  opts: {
    readonly botId?: string;
    readonly botUsername?: string | null;
    readonly chatId?: string;
    readonly chatType?: string;
    readonly messageId?: string;
    readonly rootMessageId?: string | null;
    readonly messageThreadId?: string | number | null;
  },
  threadContext: string,
): string {
  const headerParts = [
    "# Current Integration",
    "You are currently running inside: Telegram",
  ];
  if (opts.botId) {
    headerParts.push(`Bot ID: ${opts.botId}`);
  }
  if (opts.botUsername) {
    headerParts.push(`Bot username: @${opts.botUsername}`);
  }
  if (opts.chatId) {
    headerParts.push(`Chat ID: ${opts.chatId}`);
  }
  if (opts.chatType) {
    headerParts.push(`Chat type: ${opts.chatType}`);
  }
  if (opts.messageId) {
    headerParts.push(`Message ID: ${opts.messageId}`);
  }
  if (opts.rootMessageId) {
    headerParts.push(`Root message ID: ${opts.rootMessageId}`);
  }
  if (opts.messageThreadId) {
    headerParts.push(`Message thread ID: ${opts.messageThreadId}`);
  }
  return [headerParts.join("\n"), threadContext].filter(Boolean).join("\n\n");
}

async function selectedModelOverrideForUser(
  get: ComputedGetter,
  orgId: string,
  userId: string,
): Promise<string | undefined> {
  const preference = await get(userModelPreference({ orgId, userId }));
  return preference.selectedModel ?? undefined;
}

async function runAgentForTelegram(
  set: ComputedSetter,
  args: RunAgentParams,
  signal: AbortSignal,
): Promise<RunAgentResult> {
  const result = await set(
    createZeroRun$,
    {
      auth: args.auth,
      body: {
        prompt: args.prompt,
        agentId: args.agentId,
        sessionId: args.sessionId,
      },
      apiStartTime: args.apiStartTime,
      triggerSource: "telegram",
      appendSystemPrompt: args.appendSystemPrompt,
      userInfoExtras: args.userInfoExtras,
      selectedModelOverride: args.selectedModelOverride,
      callbacks: [
        {
          url: `${env("VM0_API_URL")}/api/internal/callbacks/telegram`,
          secret: generateCallbackSecret(),
          payload: args.callbackPayload,
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

  const guidance = RUN_ERROR_GUIDANCE[result.body.error.code];
  return {
    status: "failed",
    response: guidance
      ? `${guidance.title}: ${guidance.guidance}`
      : result.body.error.message,
  };
}

async function sendRunFailure(args: {
  readonly botToken: string;
  readonly chatId: string;
  readonly response: string | undefined;
  readonly replyToMessageId?: number;
}): Promise<void> {
  await postTelegramMessage({
    botToken: args.botToken,
    chatId: args.chatId,
    text: buildTelegramErrorResponse(
      args.response ?? "An unexpected error occurred. Please try again later.",
    ),
    replyToMessageId: args.replyToMessageId,
  });
}

function agentMessageScope(args: {
  readonly userLinkKind: "custom" | "official";
  readonly botId: string;
  readonly orgId: string;
  readonly userLinkId: string;
}): TelegramMessageScope {
  return args.userLinkKind === "custom"
    ? { kind: "custom", installationId: args.botId }
    : {
        kind: "official",
        orgId: args.orgId,
        userLinkId: args.userLinkId,
      };
}

function rootMessageIdForAgentMessage(args: {
  readonly isDM: boolean;
  readonly message: TelegramMessage;
  readonly botUsername: string | null;
}): string | undefined {
  if (args.isDM) {
    return "dm";
  }
  return isTelegramReplyToBotUsername(args.message, args.botUsername)
    ? String(args.message.reply_to_message?.message_id)
    : undefined;
}

async function lookupAgentThreadSession(args: {
  readonly db: Db;
  readonly chatId: string;
  readonly rootMessageId: string | undefined;
  readonly userLinkId: string;
  readonly userLinkKind: "custom" | "official";
  readonly userId: string;
  readonly composeId: string;
}): Promise<TelegramThreadLookupResult> {
  if (args.rootMessageId === undefined) {
    return { existingSessionId: undefined, lastProcessedMessageId: undefined };
  }
  return await lookupTelegramThreadSession({
    db: args.db,
    chatId: args.chatId,
    rootMessageId: args.rootMessageId,
    userLinkId: args.userLinkId,
    userLinkKind: args.userLinkKind,
    userId: args.userId,
    composeId: args.composeId,
  });
}

function buildTelegramAgentPrompt(args: {
  readonly message: TelegramMessage;
  readonly botId: string;
  readonly botUsername: string | null;
  readonly isDM: boolean;
}): {
  readonly prompt: string;
  readonly userInfoExtras: TelegramUserInfoExtras;
} {
  const enriched = enrichTelegramPrompt(args.message);
  const promptBase = args.isDM
    ? enriched.prompt
    : stripBotMention(enriched.prompt, args.botUsername);
  const replyQuote = formatReplyQuote(args.message.reply_to_message);
  const promptWithReply = replyQuote
    ? `${replyQuote}\n\n${promptBase}`
    : promptBase;
  return {
    prompt: appendTelegramMessageContext(
      promptWithReply,
      args.message,
      args.botId,
    ),
    userInfoExtras: enriched.userInfoExtras,
  };
}

function buildRunAgentParams(args: {
  readonly source: Parameters<typeof handleTelegramAgentMessage>[0];
  readonly agent: WorkspaceAgent;
  readonly chatId: string;
  readonly rootMessageId: string | undefined;
  readonly session: TelegramThreadLookupResult;
  readonly context: string;
  readonly prompt: string;
  readonly userInfoExtras: TelegramUserInfoExtras;
  readonly selectedModelOverride: string | undefined;
}): RunAgentParams {
  return {
    auth: {
      tokenType: "session",
      userId: args.source.userLink.vm0UserId,
      orgId: args.source.orgId,
      orgRole: "member",
    },
    agentId: args.agent.agentId,
    sessionId: args.session.existingSessionId,
    prompt: args.prompt,
    appendSystemPrompt: buildTelegramPrompt(
      {
        botId: args.source.botId,
        botUsername: args.source.botUsername,
        chatId: args.chatId,
        chatType: args.source.message.chat.type,
        messageId: String(args.source.message.message_id),
        rootMessageId: args.rootMessageId ?? null,
        messageThreadId: args.source.message.message_thread_id,
      },
      args.context,
    ),
    userInfoExtras: args.userInfoExtras,
    callbackPayload: {
      installationId: args.source.botId,
      chatId: args.chatId,
      messageId: String(args.source.message.message_id),
      rootMessageId: args.rootMessageId ?? null,
      userLinkId: args.source.userLink.id,
      agentId: args.source.composeId,
      existingSessionId: args.session.existingSessionId ?? null,
      isDM: args.source.isDM,
    },
    apiStartTime: args.source.apiStartTime,
    selectedModelOverride: args.selectedModelOverride,
  };
}

async function handleTelegramAgentMessage(args: {
  readonly get: ComputedGetter;
  readonly set: ComputedSetter;
  readonly db: Db;
  readonly botToken: string;
  readonly botId: string;
  readonly botUsername: string | null;
  readonly orgId: string;
  readonly userLink: TelegramUserLink | OfficialTelegramUserLink;
  readonly userLinkKind: "custom" | "official";
  readonly composeId: string;
  readonly message: TelegramMessage;
  readonly isDM: boolean;
  readonly apiStartTime: number;
  readonly signal: AbortSignal;
}): Promise<void> {
  const chatId = String(args.message.chat.id);
  const agent = await getWorkspaceAgent(args.db, args.composeId);
  args.signal.throwIfAborted();
  if (!agent) {
    await postTelegramMessage({
      botToken: args.botToken,
      chatId,
      text:
        args.userLinkKind === "official"
          ? "The workspace default agent is not configured. Please choose an agent in VM0 first."
          : "The agent is not available. Please contact the admin.",
      replyToMessageId: args.isDM ? undefined : args.message.message_id,
    });
    return;
  }

  await sendTypingActionSafely(args.botToken, chatId);
  const scope = agentMessageScope({
    userLinkKind: args.userLinkKind,
    botId: args.botId,
    orgId: args.orgId,
    userLinkId: args.userLink.id,
  });
  await storeTelegramMessage({
    db: args.db,
    scope,
    chatId,
    message: args.message,
  });
  args.signal.throwIfAborted();

  const rootMessageId = rootMessageIdForAgentMessage(args);
  const session = await lookupAgentThreadSession({
    db: args.db,
    chatId,
    rootMessageId,
    userLinkId: args.userLink.id,
    userLinkKind: args.userLinkKind,
    userId: args.userLink.vm0UserId,
    composeId: args.composeId,
  });
  args.signal.throwIfAborted();

  const context = await fetchTelegramContext({
    db: args.db,
    scope,
    chatId,
    currentMessageId: String(args.message.message_id),
    botId: args.botId,
  });
  args.signal.throwIfAborted();

  const runPrompt = buildTelegramAgentPrompt(args);
  const selectedModelOverride = await selectedModelOverrideForUser(
    args.get,
    args.orgId,
    args.userLink.vm0UserId,
  );
  args.signal.throwIfAborted();

  const result = await runAgentForTelegram(
    args.set,
    buildRunAgentParams({
      source: args,
      agent,
      chatId,
      rootMessageId,
      session,
      context,
      prompt: runPrompt.prompt,
      userInfoExtras: runPrompt.userInfoExtras,
      selectedModelOverride,
    }),
    args.signal,
  );
  args.signal.throwIfAborted();

  if (result.status === "queued") {
    await postTelegramMessage({
      botToken: args.botToken,
      chatId,
      text: QUEUED_MESSAGE,
      replyToMessageId: args.isDM ? undefined : args.message.message_id,
    });
    return;
  }
  if (result.status === "failed") {
    await sendRunFailure({
      botToken: args.botToken,
      chatId,
      response: result.response,
      replyToMessageId: args.isDM ? undefined : args.message.message_id,
    });
  }
}

async function handleModelCommand(args: {
  readonly get: ComputedGetter;
  readonly set: ComputedSetter;
  readonly botToken: string;
  readonly message: TelegramMessage;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const visibleModels = new Set(getVm0VisibleModels());
  const [policies, preference] = await Promise.all([
    args.set(
      listOrgModelPolicies$,
      { orgId: args.orgId, userId: args.userId },
      args.signal,
    ),
    args.get(userModelPreference({ orgId: args.orgId, userId: args.userId })),
  ]);
  args.signal.throwIfAborted();
  const options = policies.policies.flatMap((policy) => {
    if (
      !isSupportedRunModel(policy.model) ||
      !visibleModels.has(policy.model) ||
      policy.routeStatus !== "valid"
    ) {
      return [];
    }
    return {
      model: policy.model,
      label: policy.modelLabel,
      isDefault: policy.isDefault,
    };
  });
  const chatId = String(args.message.chat.id);
  const replyToMessageId =
    args.message.chat.type === "private" ? undefined : args.message.message_id;
  if (options.length === 0) {
    await postTelegramMessage({
      botToken: args.botToken,
      chatId,
      text: formatTelegramCommandError(
        "No models are configured for this workspace.",
      ),
      replyToMessageId,
    });
    return;
  }

  const input = commandArgument(args.message.text ?? args.message.caption);
  if (!input) {
    await postTelegramMessage({
      botToken: args.botToken,
      chatId,
      text: formatTelegramModelOptionsMessage(
        options,
        preference.selectedModel,
      ),
      replyToMessageId,
    });
    return;
  }

  const option = findModelOption(options, input);
  if (!option) {
    await postTelegramMessage({
      botToken: args.botToken,
      chatId,
      text: [
        formatTelegramCommandError(`Unknown model "${input}".`),
        "",
        formatTelegramModelOptionsMessage(options, preference.selectedModel),
      ].join("\n"),
      replyToMessageId,
    });
    return;
  }

  await args.set(
    updateUserModelPreference$,
    {
      orgId: args.orgId,
      userId: args.userId,
      preference: { selectedModel: option.model },
    },
    args.signal,
  );
  args.signal.throwIfAborted();
  await postTelegramMessage({
    botToken: args.botToken,
    chatId,
    text: formatTelegramCommandSuccess(`Switched to ${option.label}.`),
    replyToMessageId,
  });
}

function commandArgument(text: string | undefined): string {
  const trimmed = text?.trim();
  if (!trimmed) {
    return "";
  }
  const firstWhitespaceIndex = trimmed.search(/\s/u);
  if (firstWhitespaceIndex === -1) {
    return "";
  }
  return trimmed.slice(firstWhitespaceIndex).trim();
}

function lookupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-");
}

function compactLookupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

function findModelOption(
  options: readonly {
    readonly model: SupportedRunModel;
    readonly label: string;
    readonly isDefault: boolean;
  }[],
  input: string,
) {
  const normalizedInput = normalizeRunModelId(input.trim());
  const inputKeys = new Set([
    lookupKey(input),
    lookupKey(normalizedInput),
    compactLookupKey(input),
    compactLookupKey(normalizedInput),
  ]);
  return options.find((option) => {
    return [
      option.model,
      normalizeRunModelId(option.model),
      option.label,
      getCanonicalModelDisplayName(option.model),
    ].some((value) => {
      return (
        inputKeys.has(lookupKey(value)) ||
        inputKeys.has(compactLookupKey(value))
      );
    });
  });
}

function formatTelegramModelOptionsMessage(
  options: readonly {
    readonly model: SupportedRunModel;
    readonly label: string;
    readonly isDefault: boolean;
  }[],
  currentSelectedModel: string | null,
): string {
  const optionLines = options.map((option) => {
    const markers = [
      option.model === currentSelectedModel ? "current" : null,
      option.isDefault ? "workspace default" : null,
    ].filter((marker): marker is string => {
      return marker !== null;
    });
    const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
    return `• <code>/model ${escapeHtml(option.model)}</code> - ${escapeHtml(
      option.label,
    )}${escapeHtml(suffix)}`;
  });

  const current = currentSelectedModel
    ? getCanonicalModelDisplayName(currentSelectedModel)
    : "workspace default";
  return [
    "<b>Available models</b>",
    "",
    `Current: <b>${escapeHtml(current)}</b>`,
    "",
    "Send one of these commands to switch:",
    ...optionLines,
  ].join("\n");
}

async function handleCustomCommand(args: {
  readonly get: ComputedGetter;
  readonly set: ComputedSetter;
  readonly db: Db;
  readonly installation: TelegramInstallation;
  readonly botToken: string;
  readonly command: string;
  readonly message: TelegramMessage;
  readonly signal: AbortSignal;
}): Promise<void> {
  const chatId = String(args.message.chat.id);
  const fromUserId = String(args.message.from?.id ?? 0);
  const displayName = formatTelegramUserDisplayName(args.message.from ?? {});
  const replyToMessageId =
    args.message.chat.type === "private" ? undefined : args.message.message_id;
  const userLink = await resolveUserLink({
    set: args.set,
    db: args.db,
    installationId: args.installation.telegramBotId,
    telegramUserId: fromUserId,
    telegramUsername: args.message.from?.username ?? null,
    telegramDisplayName: displayName,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  const agentName = await getWorkspaceAgentDisplayLabel(
    args.db,
    args.installation.defaultComposeId,
  );

  if (args.command === "help") {
    await postTelegramMessage({
      botToken: args.botToken,
      chatId,
      text: formatTelegramHelpMessage(args.installation.botUsername, agentName),
      replyToMessageId,
    });
    return;
  }

  if (args.command === "connect" || args.command === "start") {
    if (userLink) {
      await postTelegramMessage({
        botToken: args.botToken,
        chatId,
        text: formatTelegramCommandSuccess(
          formatTelegramAlreadyConnectedMessage(
            args.installation.botUsername,
            agentName,
          ),
        ),
        replyToMessageId,
      });
      return;
    }
    await sendCustomConnectPrompt({
      db: args.db,
      botToken: args.botToken,
      installation: args.installation,
      message: args.message,
      chatId,
      displayName,
      fromUserId,
      agentName,
      replyToMessageId,
    });
    return;
  }

  if (!userLink) {
    await sendCustomConnectPrompt({
      db: args.db,
      botToken: args.botToken,
      installation: args.installation,
      message: args.message,
      chatId,
      displayName,
      fromUserId,
      agentName,
      replyToMessageId,
    });
    return;
  }

  if (args.command === "disconnect") {
    await args.db
      .delete(telegramUserLinks)
      .where(eq(telegramUserLinks.id, userLink.id));
    args.signal.throwIfAborted();
    await postTelegramMessage({
      botToken: args.botToken,
      chatId,
      text: formatTelegramCommandSuccess(
        `You have been disconnected and your access to ${agentName} has been revoked.`,
      ),
      replyToMessageId,
    });
    return;
  }

  if (args.command === "new_session") {
    if (args.message.chat.type !== "private") {
      return;
    }
    await args.db
      .delete(telegramThreadSessions)
      .where(
        and(
          eq(telegramThreadSessions.telegramUserLinkId, userLink.id),
          eq(telegramThreadSessions.chatId, chatId),
          eq(telegramThreadSessions.rootMessageId, "dm"),
        ),
      );
    args.signal.throwIfAborted();
    await postTelegramMessage({
      botToken: args.botToken,
      chatId,
      text: formatTelegramCommandSuccess("New session started."),
    });
    return;
  }

  if (args.command === "model") {
    await handleModelCommand({
      get: args.get,
      set: args.set,
      botToken: args.botToken,
      message: args.message,
      orgId: args.installation.orgId,
      userId: userLink.vm0UserId,
      signal: args.signal,
    });
  }
}

async function resolveOfficialComposeId(
  db: Db,
  userLink: OfficialTelegramUserLink,
): Promise<string | null> {
  const [preference] = await db
    .select({
      selectedComposeId: telegramUserAgentPreferences.selectedComposeId,
    })
    .from(telegramUserAgentPreferences)
    .where(
      and(
        eq(telegramUserAgentPreferences.vm0UserId, userLink.vm0UserId),
        eq(telegramUserAgentPreferences.orgId, userLink.orgId),
      ),
    )
    .limit(1);
  if (preference?.selectedComposeId) {
    const [compose] = await db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.id, preference.selectedComposeId),
          eq(agentComposes.orgId, userLink.orgId),
        ),
      )
      .limit(1);
    if (compose) {
      return compose.id;
    }
  }
  const [metadata] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, userLink.orgId))
    .limit(1);
  return metadata?.defaultAgentId ?? null;
}

async function handleOfficialCommand(args: {
  readonly get: ComputedGetter;
  readonly set: ComputedSetter;
  readonly db: Db;
  readonly botToken: string;
  readonly botUsername: string | null;
  readonly command: string;
  readonly message: TelegramMessage;
  readonly signal: AbortSignal;
}): Promise<void> {
  const chatId = String(args.message.chat.id);
  const fromUserId = String(args.message.from?.id ?? 0);
  const displayName = formatTelegramUserDisplayName(args.message.from ?? {});
  const replyToMessageId =
    args.message.chat.type === "private" ? undefined : args.message.message_id;
  const userLink = await resolveOfficialUserLink({
    set: args.set,
    db: args.db,
    telegramUserId: fromUserId,
    telegramUsername: args.message.from?.username ?? null,
    telegramDisplayName: displayName,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  if (args.command === "help") {
    await postTelegramMessage({
      botToken: args.botToken,
      chatId,
      text: formatTelegramHelpMessage(args.botUsername, "Zero"),
      replyToMessageId,
    });
    return;
  }

  if (args.command === "connect" || args.command === "start") {
    if (userLink) {
      await postTelegramMessage({
        botToken: args.botToken,
        chatId,
        text: formatTelegramCommandSuccess(
          formatTelegramAlreadyConnectedMessage(args.botUsername, "Zero"),
        ),
        replyToMessageId,
      });
      return;
    }
    await sendConnectPrompt({
      botToken: args.botToken,
      botId: OFFICIAL_TELEGRAM_BOT_ID,
      botUsername: args.botUsername,
      chatId,
      chatType: args.message.chat.type,
      fromUserId,
      telegramUsername: args.message.from?.username ?? null,
      telegramDisplayName: displayName,
      agentName: "Zero",
      replyToMessageId,
    });
    return;
  }

  if (!userLink) {
    await sendConnectPrompt({
      botToken: args.botToken,
      botId: OFFICIAL_TELEGRAM_BOT_ID,
      botUsername: args.botUsername,
      chatId,
      chatType: args.message.chat.type,
      fromUserId,
      telegramUsername: args.message.from?.username ?? null,
      telegramDisplayName: displayName,
      agentName: "Zero",
      replyToMessageId,
    });
    return;
  }

  if (args.command === "disconnect") {
    await args.db
      .delete(telegramOfficialUserLinks)
      .where(eq(telegramOfficialUserLinks.id, userLink.id));
    args.signal.throwIfAborted();
    await postTelegramMessage({
      botToken: args.botToken,
      chatId,
      text: formatTelegramCommandSuccess(
        "You have been disconnected from the official Zero bot.",
      ),
      replyToMessageId,
    });
    return;
  }

  if (args.command === "new_session") {
    if (args.message.chat.type !== "private") {
      return;
    }
    await args.db
      .delete(telegramThreadSessions)
      .where(
        and(
          eq(telegramThreadSessions.telegramOfficialUserLinkId, userLink.id),
          eq(telegramThreadSessions.chatId, chatId),
          eq(telegramThreadSessions.rootMessageId, "dm"),
        ),
      );
    args.signal.throwIfAborted();
    await postTelegramMessage({
      botToken: args.botToken,
      chatId,
      text: formatTelegramCommandSuccess("New session started."),
    });
    return;
  }

  if (args.command === "model") {
    await handleModelCommand({
      get: args.get,
      set: args.set,
      botToken: args.botToken,
      message: args.message,
      orgId: userLink.orgId,
      userId: userLink.vm0UserId,
      signal: args.signal,
    });
  }
}

interface CustomWebhookContext {
  readonly get: ComputedGetter;
  readonly set: ComputedSetter;
  readonly db: Db;
  readonly installation: TelegramInstallation;
  readonly botToken: string;
  readonly message: TelegramMessage;
  readonly apiStartTime: number;
  readonly signal: AbortSignal;
}

async function resolveCustomMessageUserLink(args: {
  readonly set: ComputedSetter;
  readonly db: Db;
  readonly installationId: string;
  readonly message: TelegramMessage;
  readonly signal: AbortSignal;
}): Promise<{
  readonly userLink: TelegramUserLink | null;
  readonly displayName: string | null;
  readonly fromUserId: string;
}> {
  const displayName = formatTelegramUserDisplayName(args.message.from ?? {});
  const fromUserId = String(args.message.from?.id ?? 0);
  const userLink = await resolveUserLink({
    set: args.set,
    db: args.db,
    installationId: args.installationId,
    telegramUserId: fromUserId,
    telegramUsername: args.message.from?.username ?? null,
    telegramDisplayName: displayName,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  return { userLink, displayName, fromUserId };
}

async function sendCustomConnectPrompt(args: {
  readonly db: Db;
  readonly botToken: string;
  readonly installation: TelegramInstallation;
  readonly message: TelegramMessage;
  readonly chatId: string;
  readonly displayName: string | null;
  readonly fromUserId: string;
  readonly agentName?: string;
  readonly replyToMessageId?: number;
}): Promise<void> {
  const agentName =
    args.agentName ??
    (await getWorkspaceAgentDisplayLabel(
      args.db,
      args.installation.defaultComposeId,
    ));
  await sendConnectPrompt({
    botToken: args.botToken,
    botId: args.installation.telegramBotId,
    botUsername: args.installation.botUsername,
    chatId: args.chatId,
    chatType: args.message.chat.type,
    fromUserId: args.fromUserId,
    telegramUsername: args.message.from?.username ?? null,
    telegramDisplayName: args.displayName,
    agentName,
    replyToMessageId: args.replyToMessageId,
  });
}

async function handleCustomPrivateWebhookMessage(
  args: CustomWebhookContext,
): Promise<void> {
  const chatId = String(args.message.chat.id);
  const resolved = await resolveCustomMessageUserLink({
    set: args.set,
    db: args.db,
    installationId: args.installation.telegramBotId,
    message: args.message,
    signal: args.signal,
  });
  if (!resolved.userLink) {
    await sendCustomConnectPrompt({ ...args, chatId, ...resolved });
    return;
  }
  await handleTelegramAgentMessage({
    get: args.get,
    set: args.set,
    db: args.db,
    botToken: args.botToken,
    botId: args.installation.telegramBotId,
    botUsername: args.installation.botUsername,
    orgId: args.installation.orgId,
    userLink: resolved.userLink,
    userLinkKind: "custom",
    composeId: args.installation.defaultComposeId,
    message: args.message,
    isDM: true,
    apiStartTime: args.apiStartTime,
    signal: args.signal,
  });
}

function isCustomGroupAddressed(
  message: TelegramMessage,
  botUsername: string | null,
): boolean {
  return (
    hasBotMention(message, botUsername) ||
    isTelegramReplyToBotUsername(message, botUsername)
  );
}

async function handleCustomAddressedGroupWebhookMessage(
  args: CustomWebhookContext,
): Promise<void> {
  const chatId = String(args.message.chat.id);
  const resolved = await resolveCustomMessageUserLink({
    set: args.set,
    db: args.db,
    installationId: args.installation.telegramBotId,
    message: args.message,
    signal: args.signal,
  });
  if (!resolved.userLink) {
    await sendCustomConnectPrompt({
      ...args,
      chatId,
      ...resolved,
      replyToMessageId: args.message.message_id,
    });
    return;
  }
  await handleTelegramAgentMessage({
    get: args.get,
    set: args.set,
    db: args.db,
    botToken: args.botToken,
    botId: args.installation.telegramBotId,
    botUsername: args.installation.botUsername,
    orgId: args.installation.orgId,
    userLink: resolved.userLink,
    userLinkKind: "custom",
    composeId: args.installation.defaultComposeId,
    message: args.message,
    isDM: false,
    apiStartTime: args.apiStartTime,
    signal: args.signal,
  });
}

const processCustomWebhookMessage$ = command(
  async (
    { get, set },
    args: {
      readonly telegramBotId: string;
      readonly message: TelegramMessage;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [installation] = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, args.telegramBotId))
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return;
    }

    const botToken = decryptSecretValue(installation.encryptedBotToken);
    const commandName = parseBotCommand(
      args.message.text ?? args.message.caption,
      installation.botUsername,
    );
    if (commandName) {
      await handleCustomCommand({
        get,
        set,
        db,
        installation,
        botToken,
        command: commandName,
        message: args.message,
        signal,
      });
      return;
    }

    const chatId = String(args.message.chat.id);
    if (args.message.chat.type === "private") {
      await handleCustomPrivateWebhookMessage({
        get,
        set,
        db,
        installation,
        botToken,
        message: args.message,
        apiStartTime: args.apiStartTime,
        signal,
      });
      return;
    }

    if (isCustomGroupAddressed(args.message, installation.botUsername)) {
      await handleCustomAddressedGroupWebhookMessage({
        get,
        set,
        db,
        installation,
        botToken,
        message: args.message,
        apiStartTime: args.apiStartTime,
        signal,
      });
      return;
    }

    await storeTelegramMessage({
      db,
      scope: { kind: "custom", installationId: installation.telegramBotId },
      chatId,
      message: args.message,
    });
  },
);

const processOfficialWebhookMessage$ = command(
  async (
    { get, set },
    args: { readonly message: TelegramMessage; readonly apiStartTime: number },
    signal: AbortSignal,
  ): Promise<void> => {
    const config = getOfficialTelegramBotConfig();
    if (!config.botToken) {
      return;
    }
    const db = set(writeDb$);
    const commandName = parseBotCommand(
      args.message.text ?? args.message.caption,
      config.botUsername,
    );
    if (commandName) {
      await handleOfficialCommand({
        get,
        set,
        db,
        botToken: config.botToken,
        botUsername: config.botUsername,
        command: commandName,
        message: args.message,
        signal,
      });
      return;
    }

    const chatId = String(args.message.chat.id);
    const displayName = formatTelegramUserDisplayName(args.message.from ?? {});
    const userLink = await resolveOfficialUserLink({
      set,
      db,
      telegramUserId: String(args.message.from?.id ?? 0),
      telegramUsername: args.message.from?.username ?? null,
      telegramDisplayName: displayName,
      signal,
    });
    signal.throwIfAborted();
    if (!userLink) {
      await sendConnectPrompt({
        botToken: config.botToken,
        botId: OFFICIAL_TELEGRAM_BOT_ID,
        botUsername: config.botUsername,
        chatId,
        chatType: args.message.chat.type,
        fromUserId: String(args.message.from?.id ?? 0),
        telegramUsername: args.message.from?.username ?? null,
        telegramDisplayName: displayName,
        agentName: "Zero",
        replyToMessageId:
          args.message.chat.type === "private"
            ? undefined
            : args.message.message_id,
      });
      signal.throwIfAborted();
      return;
    }

    if (
      args.message.chat.type !== "private" &&
      !hasBotMention(args.message, config.botUsername) &&
      !isTelegramReplyToBotUsername(args.message, config.botUsername)
    ) {
      await storeTelegramMessage({
        db,
        scope: {
          kind: "official",
          orgId: userLink.orgId,
          userLinkId: userLink.id,
        },
        chatId,
        message: args.message,
      });
      signal.throwIfAborted();
      return;
    }

    const composeId = await resolveOfficialComposeId(db, userLink);
    signal.throwIfAborted();
    if (!composeId) {
      await postTelegramMessage({
        botToken: config.botToken,
        chatId,
        text: "The workspace default agent is not configured. Please choose an agent in VM0 first.",
        replyToMessageId:
          args.message.chat.type === "private"
            ? undefined
            : args.message.message_id,
      });
      signal.throwIfAborted();
      return;
    }

    await handleTelegramAgentMessage({
      get,
      set,
      db,
      botToken: config.botToken,
      botId: OFFICIAL_TELEGRAM_BOT_ID,
      botUsername: config.botUsername,
      orgId: userLink.orgId,
      userLink,
      userLinkKind: "official",
      composeId,
      message: args.message,
      isDM: args.message.chat.type === "private",
      apiStartTime: args.apiStartTime,
      signal,
    });
  },
);

export const telegramWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const apiStartTime = now();
    const request = get(request$).raw;
    const { telegramBotId } = get(
      pathParamsOf(zeroIntegrationsTelegramContract.webhook),
    );

    if (isOfficialTelegramBotId(telegramBotId)) {
      const config = getOfficialTelegramBotConfig();
      if (!config.botToken || !config.webhookSecret) {
        return textResponse("Not Found", 404);
      }
      if (!verifyTelegramWebhook(request, config.webhookSecret)) {
        return textResponse("Unauthorized", 401);
      }
      const parsed = await settle(request.json());
      signal.throwIfAborted();
      if (!parsed.ok || !isTelegramUpdate(parsed.value)) {
        return textResponse("Bad Request", 400);
      }
      const message = parsed.value.message;
      if (!message || !hasTelegramMessageContextContent(message)) {
        return okText();
      }
      waitUntil(
        tapError(
          set(
            processOfficialWebhookMessage$,
            { message, apiStartTime },
            signal,
          ),
          (error) => {
            log.error("Error handling official Telegram webhook", { error });
          },
        ),
      );
      return okText();
    }

    const db = set(writeDb$);
    const [installation] = await db
      .select({
        telegramBotId: telegramInstallations.telegramBotId,
        webhookSecret: telegramInstallations.webhookSecret,
      })
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, telegramBotId))
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return textResponse("Not Found", 404);
    }
    if (!verifyTelegramWebhook(request, installation.webhookSecret)) {
      return textResponse("Unauthorized", 401);
    }

    const parsed = await settle(request.json());
    signal.throwIfAborted();
    if (!parsed.ok || !isTelegramUpdate(parsed.value)) {
      return textResponse("Bad Request", 400);
    }

    const message = parsed.value.message;
    if (!message || !hasTelegramMessageContextContent(message)) {
      return okText();
    }

    waitUntil(
      tapError(
        set(
          processCustomWebhookMessage$,
          { telegramBotId, message, apiStartTime },
          signal,
        ),
        (error) => {
          log.error("Error handling Telegram webhook", {
            error,
            telegramBotId,
          });
        },
      ),
    );
    return okText();
  },
);
