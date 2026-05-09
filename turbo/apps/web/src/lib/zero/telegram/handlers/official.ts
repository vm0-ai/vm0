import { and, eq } from "drizzle-orm";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";
import {
  createTelegramClient,
  sendMessage,
  type TelegramClient,
} from "../client";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  getOfficialTelegramBotConfig,
} from "../official";
import {
  resolveEffectiveTelegramComposeId,
  resolveOfficialUserLink,
} from "../official-user";
import { fetchTelegramContext } from "../context";
import { buildTelegramErrorResponse } from "../format";
import {
  appendTelegramMessageContext,
  buildConnectUrl,
  buildTelegramConnectReplyMarkup,
  buildTelegramPrivateConnectReplyMarkup,
  enrichTelegramPrompt,
  formatReplyQuote,
  formatTelegramAlreadyConnectedMessage,
  formatTelegramCommandError,
  formatTelegramCommandSuccess,
  formatTelegramConnectPrompt,
  formatTelegramHelpMessage,
  formatTelegramPrivateConnectPrompt,
  formatTelegramUserDisplayName,
  getAgentDisplayLabel,
  getWorkspaceAgent,
  isTelegramReplyToBotUsername,
  lookupTelegramThreadSession,
  resolveSessionCompose,
  resolveTelegramAuditLogsUrl,
  sendQueuedNotification,
  sendTypingAction,
  storeTelegramMessage,
} from "./shared";
import { runAgentForTelegram } from "./run-agent";
import { logger } from "../../../shared/logger";
import type { TelegramHandlerUpdate } from "./types";

const log = logger("telegram:official");

type OfficialUserLink = typeof telegramOfficialUserLinks.$inferSelect;

interface OfficialRuntime {
  botToken: string;
  botUsername: string | null;
  client: TelegramClient;
}

async function resolveOfficialRuntime(): Promise<OfficialRuntime | null> {
  const config = getOfficialTelegramBotConfig();
  if (!config.botToken) {
    log.warn("Official Telegram bot token is not configured");
    return null;
  }
  return {
    botToken: config.botToken,
    botUsername: config.botUsername,
    client: createTelegramClient(config.botToken),
  };
}

async function resolveOfficialAgent(userLink: OfficialUserLink): Promise<
  | {
      composeId: string;
      agentId: string;
      agentName: string;
    }
  | undefined
> {
  const composeId = await resolveEffectiveTelegramComposeId(
    userLink.vm0UserId,
    userLink.orgId,
  );
  if (!composeId) return undefined;

  const agent = await getWorkspaceAgent(composeId);
  if (!agent) return undefined;

  return {
    composeId,
    agentId: agent.agentId,
    agentName: getAgentDisplayLabel(agent),
  };
}

function buildOfficialConnectUrl(params: {
  botToken: string;
  telegramUserId: string;
  telegramUsername?: string | null;
  telegramDisplayName?: string | null;
}): string {
  return buildConnectUrl(
    OFFICIAL_TELEGRAM_BOT_ID,
    params.telegramUserId,
    params.botToken,
    params.telegramUsername,
    params.telegramDisplayName,
  );
}

async function sendOfficialConnectPrompt(params: {
  runtime: OfficialRuntime;
  message: TelegramHandlerUpdate["message"];
  chatId: string;
  fromUserId: string;
  telegramDisplayName: string | null;
  replyToMessageId?: number;
}): Promise<void> {
  if (params.message.chat.type !== "private") {
    await sendMessage(
      params.runtime.client,
      params.chatId,
      formatTelegramPrivateConnectPrompt(params.runtime.botUsername, "Zero"),
      {
        ...(params.replyToMessageId
          ? { replyToMessageId: params.replyToMessageId }
          : {}),
        replyMarkup: buildTelegramPrivateConnectReplyMarkup(
          params.runtime.botUsername,
        ),
      },
    );
    return;
  }

  const connectUrl = buildOfficialConnectUrl({
    botToken: params.runtime.botToken,
    telegramUserId: params.fromUserId,
    telegramUsername: params.message.from?.username ?? null,
    telegramDisplayName: params.telegramDisplayName,
  });
  await sendMessage(
    params.runtime.client,
    params.chatId,
    formatTelegramConnectPrompt("Zero"),
    {
      replyMarkup: buildTelegramConnectReplyMarkup(connectUrl),
    },
  );
}

async function resolveOfficialLinkedUser(params: {
  runtime: OfficialRuntime;
  message: TelegramHandlerUpdate["message"];
  chatId: string;
  replyToMessageId?: number;
}): Promise<OfficialUserLink | null> {
  const fromUserId = String(params.message.from?.id ?? 0);
  const telegramDisplayName = formatTelegramUserDisplayName(
    params.message.from,
  );
  const userLink = await resolveOfficialUserLink(
    fromUserId,
    params.message.from?.username ?? null,
    telegramDisplayName,
  );
  if (userLink) return userLink;

  await sendOfficialConnectPrompt({
    runtime: params.runtime,
    message: params.message,
    chatId: params.chatId,
    fromUserId,
    telegramDisplayName,
    replyToMessageId: params.replyToMessageId,
  });
  return null;
}

export async function handleOfficialTelegramDirectMessage(
  update: TelegramHandlerUpdate,
  apiStartTime: number,
): Promise<void> {
  const runtime = await resolveOfficialRuntime();
  if (!runtime) return;

  const message = update.message;
  const chatId = String(message.chat.id);
  const userLink = await resolveOfficialLinkedUser({
    runtime,
    message,
    chatId,
  });
  if (!userLink) return;

  const agent = await resolveOfficialAgent(userLink);
  if (!agent) {
    await sendMessage(
      runtime.client,
      chatId,
      "The workspace default agent is not configured. Please choose an agent in VM0 first.",
    );
    return;
  }

  await sendTypingAction(runtime.client, chatId);

  const messageScope = {
    kind: "official" as const,
    orgId: userLink.orgId,
    userLinkId: userLink.id,
  };
  await storeTelegramMessage(messageScope, chatId, message);

  const rootMessageId = "dm";
  const session = await lookupTelegramThreadSession(chatId, rootMessageId, {
    kind: "official",
    userLinkId: userLink.id,
  });
  let existingSessionId = session.existingSessionId;
  const lastProcessedMessageId = session.lastProcessedMessageId;

  if (existingSessionId) {
    const sessionCompose = await resolveSessionCompose(
      existingSessionId,
      userLink.vm0UserId,
    );
    if (sessionCompose && sessionCompose.composeId !== agent.composeId) {
      existingSessionId = undefined;
    }
  }

  const { executionContext } = await fetchTelegramContext(
    messageScope,
    chatId,
    lastProcessedMessageId,
    runtime.client,
    String(message.message_id),
  );

  const { prompt: messageContent, userInfoExtras } = enrichTelegramPrompt(
    message.text ?? message.caption ?? "",
    message.from,
  );
  let enrichedPrompt = appendTelegramMessageContext(
    messageContent,
    message,
    OFFICIAL_TELEGRAM_BOT_ID,
  );
  const replyQuote = formatReplyQuote(message.reply_to_message);
  if (replyQuote) {
    enrichedPrompt = `${replyQuote}\n\n${enrichedPrompt}`;
  }

  const { status, response, runId } = await runAgentForTelegram({
    composeId: agent.composeId,
    agentId: agent.agentId,
    agentName: agent.agentName,
    sessionId: existingSessionId,
    prompt: enrichedPrompt,
    threadContext: executionContext,
    userInfoExtras,
    botId: OFFICIAL_TELEGRAM_BOT_ID,
    botUsername: runtime.botUsername,
    chatId,
    chatType: message.chat.type,
    messageId: String(message.message_id),
    rootMessageId,
    messageThreadId: message.message_thread_id,
    userId: userLink.vm0UserId,
    apiStartTime,
    callbackContext: {
      installationId: OFFICIAL_TELEGRAM_BOT_ID,
      chatId,
      messageId: String(message.message_id),
      rootMessageId,
      userLinkId: userLink.id,
      agentId: agent.composeId,
      existingSessionId: existingSessionId ?? null,
      isDM: true,
    },
  });

  if (status === "queued") {
    await sendQueuedNotification(runtime.client, chatId);
  } else if (status === "failed") {
    const linkUrl = await resolveTelegramAuditLogsUrl({
      orgId: userLink.orgId,
      userId: userLink.vm0UserId,
      runId,
    });
    await sendMessage(
      runtime.client,
      chatId,
      buildTelegramErrorResponse(
        response ?? "An unexpected error occurred. Please try again later.",
        linkUrl,
      ),
    );
  }
}

export async function handleOfficialTelegramMention(
  update: TelegramHandlerUpdate,
  apiStartTime: number,
): Promise<void> {
  const runtime = await resolveOfficialRuntime();
  if (!runtime) return;

  const message = update.message;
  const chatId = String(message.chat.id);
  const userLink = await resolveOfficialLinkedUser({
    runtime,
    message,
    chatId,
    replyToMessageId: message.message_id,
  });
  if (!userLink) return;

  const agent = await resolveOfficialAgent(userLink);
  if (!agent) {
    await sendMessage(
      runtime.client,
      chatId,
      "The workspace default agent is not configured. Please choose an agent in VM0 first.",
      { replyToMessageId: message.message_id },
    );
    return;
  }

  await sendTypingAction(runtime.client, chatId);

  const messageScope = {
    kind: "official" as const,
    orgId: userLink.orgId,
    userLinkId: userLink.id,
  };
  await storeTelegramMessage(messageScope, chatId, message);

  const messageText = stripBotMention(
    message.text ?? message.caption ?? "",
    runtime.botUsername,
    message.entities ?? message.caption_entities,
  );
  const { prompt: messageContent, userInfoExtras } = enrichTelegramPrompt(
    messageText,
    message.from,
  );
  let enrichedPrompt = appendTelegramMessageContext(
    messageContent,
    message,
    OFFICIAL_TELEGRAM_BOT_ID,
  );
  const replyQuote = formatReplyQuote(message.reply_to_message);
  if (replyQuote) {
    enrichedPrompt = `${replyQuote}\n\n${enrichedPrompt}`;
  }

  const { rootMessageId, existingSessionId, lastProcessedMessageId } =
    await resolveOfficialThreadSession(
      message,
      chatId,
      userLink,
      agent.composeId,
      runtime.botUsername,
    );

  const { executionContext } = await fetchTelegramContext(
    messageScope,
    chatId,
    lastProcessedMessageId,
    runtime.client,
    String(message.message_id),
  );

  const { status, response, runId } = await runAgentForTelegram({
    composeId: agent.composeId,
    agentId: agent.agentId,
    agentName: agent.agentName,
    sessionId: existingSessionId,
    prompt: enrichedPrompt,
    threadContext: executionContext,
    userInfoExtras,
    botId: OFFICIAL_TELEGRAM_BOT_ID,
    botUsername: runtime.botUsername,
    chatId,
    chatType: message.chat.type,
    messageId: String(message.message_id),
    rootMessageId: rootMessageId ?? null,
    messageThreadId: message.message_thread_id,
    userId: userLink.vm0UserId,
    apiStartTime,
    callbackContext: {
      installationId: OFFICIAL_TELEGRAM_BOT_ID,
      chatId,
      messageId: String(message.message_id),
      rootMessageId: rootMessageId ?? null,
      userLinkId: userLink.id,
      agentId: agent.composeId,
      existingSessionId: existingSessionId ?? null,
      isDM: false,
    },
  });

  if (status === "queued") {
    await sendQueuedNotification(runtime.client, chatId, {
      replyToMessageId: message.message_id,
    });
  } else if (status === "failed") {
    const linkUrl = await resolveTelegramAuditLogsUrl({
      orgId: userLink.orgId,
      userId: userLink.vm0UserId,
      runId,
    });
    await sendMessage(
      runtime.client,
      chatId,
      buildTelegramErrorResponse(
        response ?? "An unexpected error occurred. Please try again later.",
        linkUrl,
      ),
      { replyToMessageId: message.message_id },
    );
  }
}

async function resolveOfficialThreadSession(
  message: TelegramHandlerUpdate["message"],
  chatId: string,
  userLink: OfficialUserLink,
  composeId: string,
  botUsername: string | null,
): Promise<{
  rootMessageId: string | undefined;
  existingSessionId: string | undefined;
  lastProcessedMessageId: string | undefined;
}> {
  let rootMessageId: string | undefined;
  const replyToMessage = message.reply_to_message;
  if (isTelegramReplyToBotUsername(message, botUsername) && replyToMessage) {
    rootMessageId = String(replyToMessage.message_id);
  }

  let existingSessionId: string | undefined;
  let lastProcessedMessageId: string | undefined;
  if (rootMessageId) {
    const session = await lookupTelegramThreadSession(chatId, rootMessageId, {
      kind: "official",
      userLinkId: userLink.id,
    });
    existingSessionId = session.existingSessionId;
    lastProcessedMessageId = session.lastProcessedMessageId;
  }

  if (existingSessionId) {
    const sessionCompose = await resolveSessionCompose(
      existingSessionId,
      userLink.vm0UserId,
    );
    if (sessionCompose && sessionCompose.composeId !== composeId) {
      existingSessionId = undefined;
      lastProcessedMessageId = undefined;
    }
  }

  return { rootMessageId, existingSessionId, lastProcessedMessageId };
}

export async function handleOfficialStartCommand(
  update: TelegramHandlerUpdate,
): Promise<void> {
  await handleOfficialConnectCommand(update);
}

export async function handleOfficialConnectCommand(
  update: TelegramHandlerUpdate,
): Promise<void> {
  const runtime = await resolveOfficialRuntime();
  if (!runtime) return;

  const message = update.message;
  const chatId = String(message.chat.id);
  const fromUserId = String(message.from?.id ?? 0);
  const telegramDisplayName = formatTelegramUserDisplayName(message.from);
  const userLink = await resolveOfficialUserLink(
    fromUserId,
    message.from?.username ?? null,
    telegramDisplayName,
  );
  const replyOptions =
    message.chat.type !== "private"
      ? { replyToMessageId: message.message_id }
      : undefined;

  if (userLink) {
    await sendMessage(
      runtime.client,
      chatId,
      formatTelegramCommandSuccess(
        formatTelegramAlreadyConnectedMessage(runtime.botUsername, "Zero"),
      ),
      replyOptions,
    );
    return;
  }

  await sendOfficialConnectPrompt({
    runtime,
    message,
    chatId,
    fromUserId,
    telegramDisplayName,
    replyToMessageId: replyOptions?.replyToMessageId,
  });
}

export async function handleOfficialDisconnectCommand(
  update: TelegramHandlerUpdate,
): Promise<void> {
  const runtime = await resolveOfficialRuntime();
  if (!runtime) return;

  const message = update.message;
  const chatId = String(message.chat.id);
  const fromUserId = String(message.from?.id ?? 0);
  const telegramDisplayName = formatTelegramUserDisplayName(message.from);
  const userLink = await resolveOfficialUserLink(
    fromUserId,
    message.from?.username ?? null,
    telegramDisplayName,
  );
  const replyOptions =
    message.chat.type !== "private"
      ? { replyToMessageId: message.message_id }
      : undefined;

  if (!userLink) {
    await sendMessage(
      runtime.client,
      chatId,
      formatTelegramCommandError("You are not connected."),
      replyOptions,
    );
    return;
  }

  await globalThis.services.db
    .delete(telegramOfficialUserLinks)
    .where(eq(telegramOfficialUserLinks.id, userLink.id));

  await sendMessage(
    runtime.client,
    chatId,
    formatTelegramCommandSuccess(
      "You have been disconnected from the official Zero bot.",
    ),
    replyOptions,
  );
}

export async function handleOfficialNewSessionCommand(
  update: TelegramHandlerUpdate,
): Promise<void> {
  const runtime = await resolveOfficialRuntime();
  if (!runtime) return;

  const message = update.message;
  if (message.chat.type !== "private") {
    return;
  }

  const chatId = String(message.chat.id);
  const fromUserId = String(message.from?.id ?? 0);
  const telegramDisplayName = formatTelegramUserDisplayName(message.from);
  const userLink = await resolveOfficialLinkedUser({
    runtime,
    message,
    chatId,
  });
  if (!userLink) return;

  await globalThis.services.db
    .delete(telegramThreadSessions)
    .where(
      and(
        eq(telegramThreadSessions.telegramOfficialUserLinkId, userLink.id),
        eq(telegramThreadSessions.chatId, chatId),
        eq(telegramThreadSessions.rootMessageId, "dm"),
      ),
    );

  await sendMessage(
    runtime.client,
    chatId,
    formatTelegramCommandSuccess("New session started."),
  );

  log.info("Official Telegram DM session reset", {
    chatId,
    telegramUserId: fromUserId,
    telegramDisplayName,
  });
}

export async function handleOfficialHelpCommand(
  update: TelegramHandlerUpdate,
): Promise<void> {
  const runtime = await resolveOfficialRuntime();
  if (!runtime) return;

  const message = update.message;
  const chatId = String(message.chat.id);
  const replyOptions =
    message.chat.type !== "private"
      ? { replyToMessageId: message.message_id }
      : undefined;

  await sendMessage(
    runtime.client,
    chatId,
    formatTelegramHelpMessage(runtime.botUsername, "Zero"),
    replyOptions,
  );
}

function stripBotMention(
  text: string,
  botUsername: string | null,
  entities?: Array<{ type: string; offset: number; length: number }>,
): string {
  if (!botUsername || !entities) return text;

  const mentionText = `@${botUsername}`;
  return text
    .replace(new RegExp(`\\s*${escapeRegExp(mentionText)}\\s*`, "gi"), " ")
    .trim();
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
