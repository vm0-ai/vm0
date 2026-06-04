import { createHmac, randomBytes } from "node:crypto";

import { command } from "ccstate";
import { and, desc, eq } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentSessions } from "@vm0/db/schema/agent-session";
import {
  telegramMessages,
  type TelegramMessageEntity,
} from "@vm0/db/schema/telegram-message";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import {
  buildTelegramErrorResponse,
  escapeHtml,
} from "../../lib/telegram-format";
import { sendChatAction, sendMessage } from "../external/telegram-client";
import { publishUserSignal } from "../external/realtime";
import { now, nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { createZeroIntegrationRun$ } from "./zero-runs-create.service";

const L = logger("TelegramDispatch");
const PENDING_TELEGRAM_USER_ID = "pending";
const MAX_CONTEXT_MESSAGES = 10;

interface TelegramUser {
  readonly id: number;
  readonly username?: string;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly language_code?: string;
  readonly is_bot?: boolean;
}

interface TelegramReplyMessage {
  readonly message_id: number;
  readonly from?: TelegramUser;
  readonly text?: string;
  readonly caption?: string;
}

export interface TelegramDispatchMessage {
  readonly message_id: number;
  readonly message_thread_id?: number;
  readonly chat: { readonly id: number; readonly type: string };
  readonly from?: TelegramUser;
  readonly text?: string;
  readonly caption?: string;
  readonly entities?: readonly TelegramMessageEntity[];
  readonly caption_entities?: readonly TelegramMessageEntity[];
  readonly reply_to_message?: TelegramReplyMessage;
}

interface TelegramDispatchUpdate {
  readonly message: TelegramDispatchMessage;
}

interface TelegramInstallation {
  readonly telegramBotId: string;
  readonly botUsername: string | null;
  readonly encryptedBotToken: string;
  readonly defaultComposeId: string;
  readonly orgId: string;
  readonly ownerUserId: string;
}

interface TelegramUserLink {
  readonly id: string;
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly telegramUsername: string | null;
  readonly telegramDisplayName: string | null;
  readonly vm0UserId: string;
}

interface TelegramAgent {
  readonly composeId: string;
  readonly agentId: string;
  readonly name: string;
  readonly displayName: string | null;
}

interface ThreadSession {
  readonly rootMessageId: string | undefined;
  readonly existingSessionId: string | undefined;
  readonly lastProcessedMessageId: string | undefined;
}

interface DispatchArgs {
  readonly update: TelegramDispatchUpdate;
  readonly installationId: string;
  readonly apiStartTime: number;
}

interface RunDispatchResult {
  readonly status: "accepted" | "queued" | "failed";
  readonly response?: string;
  readonly runId?: string;
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

function formatTelegramUserDisplayName(
  user: Pick<TelegramUser, "first_name" | "last_name"> | null | undefined,
): string | null {
  return normalizeTelegramDisplayName(
    [user?.first_name, user?.last_name]
      .map((part) => {
        return part?.trim();
      })
      .filter(Boolean)
      .join(" "),
  );
}

function normalizeBotUsername(botUsername: string | null | undefined): string {
  return botUsername?.replace(/^@/, "").trim() ?? "";
}

function isTelegramReplyToBotUsername(
  message: Pick<TelegramDispatchMessage, "reply_to_message">,
  botUsername: string | null | undefined,
): boolean {
  const username = normalizeBotUsername(botUsername).toLowerCase();
  if (!username) {
    return false;
  }

  const replyFrom = message.reply_to_message?.from;
  if (replyFrom?.is_bot !== true) {
    return false;
  }

  return normalizeBotUsername(replyFrom.username).toLowerCase() === username;
}

function formatTelegramConnectPrompt(agentName: string): string {
  return `To use ${escapeHtml(agentName)}, please connect your account first.`;
}

function formatTelegramPrivateConnectPrompt(
  botUsername: string | null,
  agentName: string,
): string {
  const username = normalizeBotUsername(botUsername);
  if (!username) {
    return `${formatTelegramConnectPrompt(agentName)}\n\nSend me /connect in a private message.`;
  }
  return formatTelegramConnectPrompt(agentName);
}

function buildTelegramConnectReplyMarkup(connectUrl: string) {
  return {
    inline_keyboard: [[{ text: "Connect", url: connectUrl }]],
  };
}

function buildTelegramPrivateConnectReplyMarkup(botUsername: string | null) {
  const username = normalizeBotUsername(botUsername);
  if (!username) {
    return undefined;
  }
  return buildTelegramConnectReplyMarkup(
    `https://t.me/${encodeURIComponent(username)}?start=connect`,
  );
}

function signConnectParams(args: {
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly timestamp: number;
  readonly botToken: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
}): string {
  const normalizedUsername = normalizeTelegramUsername(args.telegramUsername);
  const normalizedDisplayName = normalizeTelegramDisplayName(
    args.telegramDisplayName,
  );
  let data = `${args.installationId}:${args.telegramUserId}:${args.timestamp}`;
  if (normalizedUsername || normalizedDisplayName) {
    data += `:${normalizedUsername ?? ""}`;
  }
  if (normalizedDisplayName) {
    data += `:${normalizedDisplayName}`;
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
  const telegramUsername = normalizeTelegramUsername(args.telegramUsername);
  const telegramDisplayName = normalizeTelegramDisplayName(
    args.telegramDisplayName,
  );
  const params = new URLSearchParams({
    bot: args.installationId,
    tgUser: args.telegramUserId,
    ts: String(timestamp),
    sig: signConnectParams({
      installationId: args.installationId,
      telegramUserId: args.telegramUserId,
      timestamp,
      botToken: args.botToken,
      telegramUsername,
      telegramDisplayName,
    }),
  });
  if (telegramUsername) {
    params.set("tgUserName", telegramUsername);
  }
  if (telegramDisplayName) {
    params.set("tgDisplayName", telegramDisplayName);
  }
  return `${env("APP_URL")}/telegram/connect?${params.toString()}`;
}

function agentDisplayLabel(agent: TelegramAgent): string {
  const displayName = agent.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return agent.name.trim() || "zero";
}

function extractEntities(
  message: TelegramDispatchMessage,
): readonly TelegramMessageEntity[] | undefined {
  const source = message.text ? message.entities : message.caption_entities;
  const entities = source?.filter((entity) => {
    return (
      typeof entity.type === "string" &&
      Number.isInteger(entity.offset) &&
      Number.isInteger(entity.length) &&
      entity.offset >= 0 &&
      entity.length > 0
    );
  });
  return entities && entities.length > 0 ? entities : undefined;
}

function formatEntityText(text: string, entity: TelegramMessageEntity): string {
  return text.slice(entity.offset, entity.offset + entity.length);
}

function formatEntity(entity: TelegramMessageEntity, text: string): string {
  const value = formatEntityText(text, entity);
  if (entity.type === "mention") {
    return `mention ${value}`;
  }
  return `${entity.type} ${JSON.stringify(value)}`;
}

function formatCurrentTelegramEntitiesForPrompt(
  message: TelegramDispatchMessage,
): string | undefined {
  const text = message.text ?? message.caption ?? "";
  const entities = extractEntities(message);
  if (!entities) {
    return undefined;
  }
  const summary = entities
    .map((entity) => {
      return formatEntity(entity, text);
    })
    .join("; ");
  return summary ? `[Telegram entities]\n${summary}` : undefined;
}

function appendTelegramMessageContext(
  prompt: string,
  message: TelegramDispatchMessage,
): string {
  const entities = formatCurrentTelegramEntitiesForPrompt(message);
  if (!entities) {
    return prompt;
  }
  return prompt ? `${prompt}\n\n${entities}` : entities;
}

function formatReplyQuote(
  replyMessage: TelegramDispatchMessage["reply_to_message"],
): string | undefined {
  const replyText = replyMessage?.text ?? replyMessage?.caption;
  if (!replyMessage || !replyText) {
    return undefined;
  }
  const sender = replyMessage.from?.username
    ? `@${replyMessage.from.username}`
    : (replyMessage.from?.first_name ?? "Unknown");
  return `[Replying to ${sender}]\n> ${replyText}`;
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
      cursor++;
    }
  }
  return result.trim();
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
    "# Current Integration\nYou are currently running inside: Telegram",
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

function routeErrorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return undefined;
  }
  const error = body.error;
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return undefined;
  }
  return typeof error.message === "string" ? error.message : undefined;
}

function stringField(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

async function sendTypingAction(args: {
  readonly botToken: string;
  readonly chatId: string;
}): Promise<void> {
  const result = await settle(
    sendChatAction(args.botToken, args.chatId, "typing"),
  );
  if (!result.ok) {
    L.debug("Failed to send Telegram typing action", {
      chatId: args.chatId,
      error: result.error,
    });
  }
}

async function sendQueuedNotification(args: {
  readonly botToken: string;
  readonly chatId: string;
  readonly replyToMessageId?: number;
}): Promise<void> {
  await sendMessage(
    args.botToken,
    args.chatId,
    "Run queued: concurrency limit reached. Will start automatically when a slot is available.",
    { replyToMessageId: args.replyToMessageId },
  );
}

async function sendAgentError(args: {
  readonly botToken: string;
  readonly chatId: string;
  readonly message: string;
  readonly runId: string | undefined;
  readonly replyToMessageId?: number;
}): Promise<void> {
  const logsUrl = args.runId
    ? `${env("APP_URL")}/activities/${encodeURIComponent(args.runId)}`
    : undefined;
  await sendMessage(
    args.botToken,
    args.chatId,
    buildTelegramErrorResponse(args.message, logsUrl),
    { replyToMessageId: args.replyToMessageId },
  );
}

async function loadInstallation(
  db: Db,
  installationId: string,
): Promise<TelegramInstallation | null> {
  const [installation] = await db
    .select({
      telegramBotId: telegramInstallations.telegramBotId,
      botUsername: telegramInstallations.botUsername,
      encryptedBotToken: telegramInstallations.encryptedBotToken,
      defaultComposeId: telegramInstallations.defaultComposeId,
      orgId: telegramInstallations.orgId,
      ownerUserId: telegramInstallations.ownerUserId,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, installationId))
    .limit(1);
  return installation ?? null;
}

async function publishTelegramUserChanged(userId: string): Promise<void> {
  const result = await settle(publishUserSignal([userId], "telegram:changed"));
  if (!result.ok) {
    L.warn("Failed to publish Telegram user change", { error: result.error });
  }
}

async function touchTelegramUserLink(
  db: Db,
  userLink: TelegramUserLink,
  telegramUsername: string | null | undefined,
  telegramDisplayName: string | null | undefined,
): Promise<TelegramUserLink> {
  const nextTelegramUsername =
    telegramUsername === undefined
      ? userLink.telegramUsername
      : normalizeTelegramUsername(telegramUsername);
  const nextTelegramDisplayName =
    telegramDisplayName === undefined
      ? userLink.telegramDisplayName
      : normalizeTelegramDisplayName(telegramDisplayName);
  const [updated] = await db
    .update(telegramUserLinks)
    .set({
      telegramUsername: nextTelegramUsername,
      telegramDisplayName: nextTelegramDisplayName,
      updatedAt: nowDate(),
    })
    .where(eq(telegramUserLinks.id, userLink.id))
    .returning();
  return updated ?? userLink;
}

async function completePendingLink(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
  readonly signal: AbortSignal;
}): Promise<TelegramUserLink | null> {
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

  const [existingTelegramLink] = await args.db
    .select()
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, args.installationId),
        eq(telegramUserLinks.telegramUserId, args.telegramUserId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (existingTelegramLink) {
    return null;
  }

  const [updated] = await args.db
    .update(telegramUserLinks)
    .set({
      telegramUserId: args.telegramUserId,
      telegramUsername: normalizeTelegramUsername(args.telegramUsername),
      telegramDisplayName: normalizeTelegramDisplayName(
        args.telegramDisplayName,
      ),
      updatedAt: nowDate(),
    })
    .where(eq(telegramUserLinks.id, pending.id))
    .returning();
  args.signal.throwIfAborted();
  if (updated) {
    await publishTelegramUserChanged(updated.vm0UserId);
  }
  return updated ?? null;
}

async function resolveUserLink(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
  readonly signal: AbortSignal;
}): Promise<TelegramUserLink | null> {
  const [userLink] = await args.db
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

  if (userLink) {
    const updated = await touchTelegramUserLink(
      args.db,
      userLink,
      args.telegramUsername,
      args.telegramDisplayName,
    );
    args.signal.throwIfAborted();
    return updated;
  }

  return await completePendingLink(args);
}

async function getWorkspaceAgent(
  db: Db,
  composeId: string,
): Promise<TelegramAgent | null> {
  const [agent] = await db
    .select({
      composeId: agentComposes.id,
      agentId: zeroAgents.id,
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
    })
    .from(agentComposes)
    .innerJoin(zeroAgents, eq(zeroAgents.id, agentComposes.id))
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  return agent ?? null;
}

async function getWorkspaceAgentDisplayLabel(
  db: Db,
  composeId: string,
): Promise<string> {
  const agent = await getWorkspaceAgent(db, composeId);
  return agent ? agentDisplayLabel(agent) : "Zero";
}

async function storeTelegramMessage(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly chatId: string;
  readonly message: TelegramDispatchMessage;
}): Promise<void> {
  const entities = extractEntities(args.message);
  await args.db
    .insert(telegramMessages)
    .values({
      installationId: args.installationId,
      chatId: args.chatId,
      messageId: String(args.message.message_id),
      fromUserId: String(args.message.from?.id ?? 0),
      fromUsername: args.message.from?.username ?? null,
      fromDisplayName: formatTelegramUserDisplayName(args.message.from),
      text: args.message.text ?? args.message.caption ?? null,
      entities: entities ? [...entities] : null,
      isBot: args.message.from?.is_bot ?? false,
    })
    .onConflictDoNothing();
}

async function lookupTelegramThreadSession(args: {
  readonly db: Db;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly userLinkId: string;
}): Promise<{
  readonly existingSessionId: string | undefined;
  readonly lastProcessedMessageId: string | undefined;
}> {
  const [session] = await args.db
    .select({
      agentSessionId: telegramThreadSessions.agentSessionId,
      lastProcessedMessageId: telegramThreadSessions.lastProcessedMessageId,
    })
    .from(telegramThreadSessions)
    .where(
      and(
        eq(telegramThreadSessions.telegramUserLinkId, args.userLinkId),
        eq(telegramThreadSessions.chatId, args.chatId),
        eq(telegramThreadSessions.rootMessageId, args.rootMessageId),
      ),
    )
    .limit(1);
  return {
    existingSessionId: session?.agentSessionId,
    lastProcessedMessageId: session?.lastProcessedMessageId ?? undefined,
  };
}

async function resolveSessionCompose(args: {
  readonly db: Db;
  readonly sessionId: string;
  readonly userId: string;
}): Promise<string | undefined> {
  const [session] = await args.db
    .select({ agentComposeId: agentSessions.agentComposeId })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, args.sessionId),
        eq(agentSessions.userId, args.userId),
      ),
    )
    .limit(1);
  return session?.agentComposeId;
}

async function resetIncompatibleSession(args: {
  readonly db: Db;
  readonly existingSessionId: string | undefined;
  readonly lastProcessedMessageId: string | undefined;
  readonly userId: string;
  readonly composeId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly existingSessionId: string | undefined;
  readonly lastProcessedMessageId: string | undefined;
}> {
  if (!args.existingSessionId) {
    return {
      existingSessionId: undefined,
      lastProcessedMessageId: args.lastProcessedMessageId,
    };
  }

  const sessionComposeId = await resolveSessionCompose({
    db: args.db,
    sessionId: args.existingSessionId,
    userId: args.userId,
  });
  args.signal.throwIfAborted();
  if (sessionComposeId && sessionComposeId !== args.composeId) {
    return { existingSessionId: undefined, lastProcessedMessageId: undefined };
  }

  return {
    existingSessionId: args.existingSessionId,
    lastProcessedMessageId: args.lastProcessedMessageId,
  };
}

async function resolveDirectMessageSession(args: {
  readonly db: Db;
  readonly chatId: string;
  readonly userLinkId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly signal: AbortSignal;
}): Promise<ThreadSession> {
  const rootMessageId = "dm";
  const session = await lookupTelegramThreadSession({
    db: args.db,
    chatId: args.chatId,
    rootMessageId,
    userLinkId: args.userLinkId,
  });
  args.signal.throwIfAborted();
  const compatible = await resetIncompatibleSession({
    db: args.db,
    existingSessionId: session.existingSessionId,
    lastProcessedMessageId: session.lastProcessedMessageId,
    userId: args.userId,
    composeId: args.composeId,
    signal: args.signal,
  });
  return { rootMessageId, ...compatible };
}

async function resolveMentionThreadSession(args: {
  readonly db: Db;
  readonly message: TelegramDispatchMessage;
  readonly chatId: string;
  readonly userLinkId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly botUsername: string | null;
  readonly signal: AbortSignal;
}): Promise<ThreadSession> {
  const rootMessageId =
    isTelegramReplyToBotUsername(args.message, args.botUsername) &&
    args.message.reply_to_message
      ? String(args.message.reply_to_message.message_id)
      : undefined;
  if (!rootMessageId) {
    return {
      rootMessageId: undefined,
      existingSessionId: undefined,
      lastProcessedMessageId: undefined,
    };
  }

  const session = await lookupTelegramThreadSession({
    db: args.db,
    chatId: args.chatId,
    rootMessageId,
    userLinkId: args.userLinkId,
  });
  args.signal.throwIfAborted();
  const compatible = await resetIncompatibleSession({
    db: args.db,
    existingSessionId: session.existingSessionId,
    lastProcessedMessageId: session.lastProcessedMessageId,
    userId: args.userId,
    composeId: args.composeId,
    signal: args.signal,
  });
  return { rootMessageId, ...compatible };
}

function formatContextMessage(args: {
  readonly text: string | null;
  readonly entities: TelegramMessageEntity[] | null;
  readonly fromUsername: string | null;
  readonly fromDisplayName: string | null;
  readonly fromUserId: string;
  readonly isBot: boolean;
  readonly messageId: string;
  readonly relativeIndex: number;
}): string {
  const senderParts = args.isBot ? ["id: BOT"] : [`id: ${args.fromUserId}`];
  if (!args.isBot && args.fromUsername) {
    senderParts.push(`username: @${args.fromUsername}`);
  }
  if (!args.isBot && args.fromDisplayName) {
    senderParts.push(`name: ${args.fromDisplayName}`);
  }
  const entitySummary =
    args.entities && args.text
      ? args.entities
          .map((entity) => {
            return formatEntity(entity, args.text ?? "");
          })
          .join("; ")
      : undefined;
  return [
    "---",
    "",
    `- RELATIVE_INDEX: ${args.relativeIndex}`,
    `- MSG_ID: ${args.messageId}`,
    `- SENDER: {${senderParts.join(", ")}}`,
    ...(entitySummary ? [`- ENTITIES: ${entitySummary}`] : []),
    "",
    args.text ?? "",
  ].join("\n");
}

async function fetchTelegramContext(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly chatId: string;
  readonly currentMessageId: string;
}): Promise<string> {
  const messages = await args.db
    .select({
      fromUsername: telegramMessages.fromUsername,
      fromDisplayName: telegramMessages.fromDisplayName,
      fromUserId: telegramMessages.fromUserId,
      text: telegramMessages.text,
      entities: telegramMessages.entities,
      isBot: telegramMessages.isBot,
      messageId: telegramMessages.messageId,
    })
    .from(telegramMessages)
    .where(
      and(
        eq(telegramMessages.installationId, args.installationId),
        eq(telegramMessages.chatId, args.chatId),
      ),
    )
    .orderBy(desc(telegramMessages.createdAt))
    .limit(MAX_CONTEXT_MESSAGES);

  const chronological = messages.reverse().filter((message) => {
    return message.messageId !== args.currentMessageId;
  });
  if (chronological.length === 0) {
    return "";
  }
  const totalMessages = chronological.length;
  const formatted = chronological.map((message, index) => {
    return formatContextMessage({
      ...message,
      relativeIndex: index - totalMessages,
    });
  });
  return [
    "# Telegram Chat Context",
    "",
    "The messages below are from a Telegram conversation.",
    "",
    formatted.join("\n\n"),
    "",
    "---",
  ].join("\n");
}

const runAgentForTelegram$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly sessionId: string | undefined;
      readonly prompt: string;
      readonly appendSystemPrompt: string;
      readonly userInfoExtras: {
        readonly telegramDisplayName?: string;
        readonly telegramUsername?: string;
        readonly telegramUserId?: string;
        readonly telegramLanguage?: string;
      };
      readonly apiStartTime: number;
      readonly callbackPayload: unknown;
    },
    signal: AbortSignal,
  ): Promise<RunDispatchResult> => {
    const result = await set(
      createZeroIntegrationRun$,
      {
        userId: args.userId,
        orgId: args.orgId,
        agentId: args.agentId,
        sessionId: args.sessionId,
        prompt: args.prompt,
        appendSystemPrompt: args.appendSystemPrompt,
        triggerSource: "telegram",
        userInfoExtras: args.userInfoExtras,
        callbacks: [
          {
            url: `${env("VM0_API_URL")}/api/internal/callbacks/telegram`,
            secret: randomBytes(32).toString("hex"),
            payload: args.callbackPayload,
          },
        ],
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.status !== 201) {
      return {
        status: "failed",
        response:
          routeErrorMessage(result.body) ??
          "Something went wrong while starting the agent. Please try again later.",
      };
    }

    const status = stringField(result.body, "status");
    const runId = stringField(result.body, "runId");
    if (status === "queued") {
      return { status: "queued", runId };
    }
    if (status === "failed") {
      return {
        status: "failed",
        runId,
        response:
          stringField(result.body, "error") ??
          "Something went wrong while starting the agent. Please try again later.",
      };
    }
    return { status: "accepted", runId };
  },
);

function telegramUserInfoExtras(message: TelegramDispatchMessage): {
  readonly telegramDisplayName?: string;
  readonly telegramUsername?: string;
  readonly telegramUserId?: string;
  readonly telegramLanguage?: string;
} {
  const from = message.from;
  if (!from) {
    return {};
  }
  return {
    telegramDisplayName: formatTelegramUserDisplayName(from) ?? undefined,
    telegramUsername: from.username ? `@${from.username}` : undefined,
    telegramUserId: String(from.id),
    telegramLanguage: from.language_code,
  };
}

const dispatchTelegramMessage$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly installation: TelegramInstallation;
      readonly userLink: TelegramUserLink;
      readonly agent: TelegramAgent;
      readonly botToken: string;
      readonly message: TelegramDispatchMessage;
      readonly chatId: string;
      readonly session: ThreadSession;
      readonly prompt: string;
      readonly apiStartTime: number;
      readonly isDM: boolean;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const context = await fetchTelegramContext({
      db: args.db,
      installationId: args.installation.telegramBotId,
      chatId: args.chatId,
      currentMessageId: String(args.message.message_id),
    });
    signal.throwIfAborted();

    const result = await set(
      runAgentForTelegram$,
      {
        userId: args.userLink.vm0UserId,
        orgId: args.installation.orgId,
        agentId: args.agent.agentId,
        sessionId: args.session.existingSessionId,
        prompt: args.prompt,
        appendSystemPrompt: buildTelegramPrompt(
          {
            botId: args.installation.telegramBotId,
            botUsername: args.installation.botUsername,
            chatId: args.chatId,
            chatType: args.message.chat.type,
            messageId: String(args.message.message_id),
            rootMessageId: args.session.rootMessageId ?? null,
            messageThreadId: args.message.message_thread_id,
          },
          context,
        ),
        userInfoExtras: telegramUserInfoExtras(args.message),
        apiStartTime: args.apiStartTime,
        callbackPayload: {
          installationId: args.installation.telegramBotId,
          chatId: args.chatId,
          messageId: String(args.message.message_id),
          rootMessageId: args.session.rootMessageId ?? null,
          userLinkId: args.userLink.id,
          agentId: args.installation.defaultComposeId,
          existingSessionId: args.session.existingSessionId ?? null,
          isDM: args.isDM,
        },
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "queued") {
      await sendQueuedNotification({
        botToken: args.botToken,
        chatId: args.chatId,
        replyToMessageId: args.isDM ? undefined : args.message.message_id,
      });
      signal.throwIfAborted();
      return;
    }

    if (result.status === "failed") {
      await sendAgentError({
        botToken: args.botToken,
        chatId: args.chatId,
        message:
          result.response ??
          "An unexpected error occurred. Please try again later.",
        runId: result.runId,
        replyToMessageId: args.isDM ? undefined : args.message.message_id,
      });
      signal.throwIfAborted();
    }
  },
);

async function resolveDispatchBase(args: {
  readonly db: Db;
  readonly update: TelegramDispatchUpdate;
  readonly installationId: string;
  readonly signal: AbortSignal;
}): Promise<
  | {
      readonly kind: "ready";
      readonly installation: TelegramInstallation;
      readonly userLink: TelegramUserLink;
      readonly agent: TelegramAgent;
      readonly botToken: string;
      readonly message: TelegramDispatchMessage;
      readonly chatId: string;
    }
  | { readonly kind: "stop" }
> {
  const message = args.update.message;
  const chatId = String(message.chat.id);
  const fromUserId = String(message.from?.id ?? 0);
  const installation = await loadInstallation(args.db, args.installationId);
  args.signal.throwIfAborted();
  if (!installation) {
    L.error("Telegram installation not found", {
      installationId: args.installationId,
    });
    return { kind: "stop" };
  }

  const botToken = await decryptPersistentSecretValue(
    installation.encryptedBotToken,
    await loadUserFeatureSwitchContext(
      args.db,
      installation.orgId,
      installation.ownerUserId,
    ),
  );
  const telegramDisplayName = formatTelegramUserDisplayName(message.from);
  const userLink = await resolveUserLink({
    db: args.db,
    installationId: args.installationId,
    telegramUserId: fromUserId,
    telegramUsername: message.from?.username ?? null,
    telegramDisplayName,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  if (!userLink) {
    const agentName = await getWorkspaceAgentDisplayLabel(
      args.db,
      installation.defaultComposeId,
    );
    args.signal.throwIfAborted();
    const connectUrl = buildConnectUrl({
      installationId: installation.telegramBotId,
      telegramUserId: fromUserId,
      botToken,
      telegramUsername: message.from?.username ?? null,
      telegramDisplayName,
    });
    const isDM = message.chat.type === "private";
    await sendMessage(
      botToken,
      chatId,
      isDM
        ? formatTelegramConnectPrompt(agentName)
        : formatTelegramPrivateConnectPrompt(
            installation.botUsername,
            agentName,
          ),
      {
        replyToMessageId: isDM ? undefined : message.message_id,
        replyMarkup: isDM
          ? buildTelegramConnectReplyMarkup(connectUrl)
          : buildTelegramPrivateConnectReplyMarkup(installation.botUsername),
      },
    );
    return { kind: "stop" };
  }

  const agent = await getWorkspaceAgent(args.db, installation.defaultComposeId);
  args.signal.throwIfAborted();
  if (!agent) {
    await sendMessage(
      botToken,
      chatId,
      "The agent is not available. Please contact the admin.",
      {
        replyToMessageId:
          message.chat.type === "private" ? undefined : message.message_id,
      },
    );
    return { kind: "stop" };
  }

  return {
    kind: "ready",
    installation,
    userLink,
    agent,
    botToken,
    message,
    chatId,
  };
}

export const dispatchTelegramDirectMessage$ = command(
  async ({ set }, args: DispatchArgs, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const base = await resolveDispatchBase({
      db,
      update: args.update,
      installationId: args.installationId,
      signal,
    });
    signal.throwIfAborted();
    if (base.kind === "stop") {
      return;
    }

    await sendTypingAction({ botToken: base.botToken, chatId: base.chatId });
    signal.throwIfAborted();
    await storeTelegramMessage({
      db,
      installationId: base.installation.telegramBotId,
      chatId: base.chatId,
      message: base.message,
    });
    signal.throwIfAborted();

    const session = await resolveDirectMessageSession({
      db,
      chatId: base.chatId,
      userLinkId: base.userLink.id,
      userId: base.userLink.vm0UserId,
      composeId: base.installation.defaultComposeId,
      signal,
    });
    signal.throwIfAborted();

    const basePrompt = base.message.text ?? base.message.caption ?? "";
    let prompt = appendTelegramMessageContext(basePrompt, base.message);
    const replyQuote = formatReplyQuote(base.message.reply_to_message);
    if (replyQuote) {
      prompt = `${replyQuote}\n\n${prompt}`;
    }

    await set(
      dispatchTelegramMessage$,
      {
        db,
        installation: base.installation,
        userLink: base.userLink,
        agent: base.agent,
        botToken: base.botToken,
        message: base.message,
        chatId: base.chatId,
        session,
        prompt,
        apiStartTime: args.apiStartTime,
        isDM: true,
      },
      signal,
    );
  },
);

export const dispatchTelegramMention$ = command(
  async ({ set }, args: DispatchArgs, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const base = await resolveDispatchBase({
      db,
      update: args.update,
      installationId: args.installationId,
      signal,
    });
    signal.throwIfAborted();
    if (base.kind === "stop") {
      return;
    }

    await sendTypingAction({ botToken: base.botToken, chatId: base.chatId });
    signal.throwIfAborted();
    await storeTelegramMessage({
      db,
      installationId: base.installation.telegramBotId,
      chatId: base.chatId,
      message: base.message,
    });
    signal.throwIfAborted();

    const session = await resolveMentionThreadSession({
      db,
      message: base.message,
      chatId: base.chatId,
      userLinkId: base.userLink.id,
      userId: base.userLink.vm0UserId,
      composeId: base.installation.defaultComposeId,
      botUsername: base.installation.botUsername,
      signal,
    });
    signal.throwIfAborted();

    const text = stripBotMention(
      base.message.text ?? base.message.caption ?? "",
      base.installation.botUsername,
    );
    let prompt = appendTelegramMessageContext(text, base.message);
    const replyQuote = formatReplyQuote(base.message.reply_to_message);
    if (replyQuote) {
      prompt = `${replyQuote}\n\n${prompt}`;
    }

    await set(
      dispatchTelegramMessage$,
      {
        db,
        installation: base.installation,
        userLink: base.userLink,
        agent: base.agent,
        botToken: base.botToken,
        message: base.message,
        chatId: base.chatId,
        session,
        prompt,
        apiStartTime: args.apiStartTime,
        isDM: false,
      },
      signal,
    );
  },
);
