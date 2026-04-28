import { eq, and } from "drizzle-orm";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { getAppUrl } from "../../url";
import { resolveAgentId } from "../../zero-compose-service";
import { validateAgentSession } from "../../zero-run-validation";
import { ensureStorageExists } from "../../../infra/storage/storage-service";
import { loadFeatureSwitchOverrides } from "../../user/feature-switches-service";
import {
  sendMessage,
  sendChatAction,
  type TelegramClient,
  type TelegramInlineKeyboardMarkup,
  type TelegramSendMessageOptions,
} from "../client";
import { escapeHtml } from "../format";
import { signConnectParams } from "../connect-token";
import {
  extractTelegramFileForContext,
  formatTelegramFileForContext,
  hasTelegramFileForContext,
  type TelegramFileContext,
} from "../images";
import {
  extractTelegramMessageEntities,
  formatCurrentTelegramEntitiesForPrompt,
} from "../entities";
import { publishTelegramUserChangedSafely } from "../realtime";
import { logger } from "../../../shared/logger";
import type { TelegramHandlerUpdate } from "./types";
import type { UserInfoOptions } from "../../integration-prompt";

const log = logger("telegram:shared");

type TelegramContextMessageInput = Omit<
  TelegramHandlerUpdate["message"],
  "chat"
> & {
  chat?: TelegramHandlerUpdate["message"]["chat"];
};

/**
 * Sentinel value for a pending user link that hasn't been claimed yet.
 * Set as telegramUserId at link time, replaced with the real
 * Telegram user ID when the user sends their first message.
 */
export const PENDING_TELEGRAM_USER_ID = "pending";

export type LinkTelegramUserResult =
  | {
      ok: true;
      userLink: typeof telegramUserLinks.$inferSelect;
    }
  | {
      ok: false;
      reason: "telegram-user-linked" | "vm0-user-linked" | "conflict";
      userLink?: typeof telegramUserLinks.$inferSelect;
    };

interface ThreadSessionLookup {
  existingSessionId: string | undefined;
  lastProcessedMessageId: string | undefined;
}

/**
 * Look up an existing thread session by chat + rootMessageId + user link.
 */
export async function lookupTelegramThreadSession(
  chatId: string,
  rootMessageId: string,
  userLinkId: string,
): Promise<ThreadSessionLookup> {
  const [session] = await globalThis.services.db
    .select({
      agentSessionId: telegramThreadSessions.agentSessionId,
      lastProcessedMessageId: telegramThreadSessions.lastProcessedMessageId,
    })
    .from(telegramThreadSessions)
    .where(
      and(
        eq(telegramThreadSessions.telegramUserLinkId, userLinkId),
        eq(telegramThreadSessions.chatId, chatId),
        eq(telegramThreadSessions.rootMessageId, rootMessageId),
      ),
    )
    .limit(1);

  return {
    existingSessionId: session?.agentSessionId,
    lastProcessedMessageId: session?.lastProcessedMessageId ?? undefined,
  };
}

/**
 * Create or update a thread session mapping after agent execution.
 */
export async function saveTelegramThreadSession(opts: {
  userLinkId: string;
  chatId: string;
  rootMessageId: string;
  previousRootMessageId: string | undefined;
  existingSessionId: string | undefined;
  newSessionId: string | undefined;
  messageId: string;
  runStatus: string;
}): Promise<void> {
  const {
    userLinkId,
    chatId,
    rootMessageId,
    previousRootMessageId,
    existingSessionId,
    newSessionId,
    messageId,
    runStatus,
  } = opts;

  if (!existingSessionId && newSessionId) {
    // New thread — create mapping
    await globalThis.services.db
      .insert(telegramThreadSessions)
      .values({
        telegramUserLinkId: userLinkId,
        chatId,
        rootMessageId,
        agentSessionId: newSessionId,
        lastProcessedMessageId: messageId,
      })
      .onConflictDoNothing();
  } else if (
    existingSessionId &&
    (runStatus === "completed" || runStatus === "timeout")
  ) {
    // Existing thread, successful run — update rootMessageId to bot's latest
    // reply so the user can continue by replying to any bot response.
    const matchRootMessageId = previousRootMessageId ?? rootMessageId;
    await globalThis.services.db
      .update(telegramThreadSessions)
      .set({
        rootMessageId,
        lastProcessedMessageId: messageId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(telegramThreadSessions.telegramUserLinkId, userLinkId),
          eq(telegramThreadSessions.chatId, chatId),
          eq(telegramThreadSessions.rootMessageId, matchRootMessageId),
        ),
      );
  }
  // Failed runs — do not update lastProcessedMessageId (allows retry with same context)
}

/**
 * Store an incoming Telegram message for context retrieval.
 * Stores the text/caption, first supported attachment, and rich entities.
 */
export async function storeTelegramMessage(
  installationId: string,
  chatId: string,
  message: TelegramContextMessageInput,
): Promise<void> {
  const file = extractTelegramFileForContext(message);
  const entities = extractTelegramMessageEntities(message);

  await globalThis.services.db
    .insert(telegramMessages)
    .values({
      installationId,
      chatId,
      messageId: String(message.message_id),
      fromUserId: String(message.from?.id ?? 0),
      fromUsername: message.from?.username ?? null,
      text: message.text ?? message.caption ?? null,
      ...telegramFileDbValues(file),
      entities: entities ?? null,
      isBot: message.from?.is_bot ?? false,
    })
    .onConflictDoNothing();
}

function telegramFileDbValues(file: TelegramFileContext | undefined): {
  fileId: string | null;
  fileType: string | null;
  fileName: string | null;
  fileMimeType: string | null;
  fileSize: number | null;
  fileWidth: number | null;
  fileHeight: number | null;
  fileDuration: number | null;
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

async function touchTelegramUserLink(
  userLink: typeof telegramUserLinks.$inferSelect,
): Promise<typeof telegramUserLinks.$inferSelect> {
  const [updated] = await globalThis.services.db
    .update(telegramUserLinks)
    .set({ updatedAt: new Date() })
    .where(eq(telegramUserLinks.id, userLink.id))
    .returning();
  return updated ?? userLink;
}

/**
 * Link one Telegram account to one VM0 user for a bot installation.
 *
 * A Telegram user can be linked to different VM0 users across different bots,
 * but within one bot both sides are one-to-one:
 * - (installationId, telegramUserId) is unique
 * - (installationId, vm0UserId) is unique
 */
export async function linkTelegramUserToVm0User(params: {
  installationId: string;
  telegramUserId: string;
  vm0UserId: string;
}): Promise<LinkTelegramUserResult> {
  const [existingTelegramLink] = await globalThis.services.db
    .select()
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, params.installationId),
        eq(telegramUserLinks.telegramUserId, params.telegramUserId),
      ),
    )
    .limit(1);

  if (existingTelegramLink) {
    if (existingTelegramLink.vm0UserId === params.vm0UserId) {
      const userLink = await touchTelegramUserLink(existingTelegramLink);
      await publishTelegramUserChangedSafely(params.vm0UserId);
      return {
        ok: true,
        userLink,
      };
    }

    return {
      ok: false,
      reason: "telegram-user-linked",
      userLink: existingTelegramLink,
    };
  }

  const [existingVm0Link] = await globalThis.services.db
    .select()
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, params.installationId),
        eq(telegramUserLinks.vm0UserId, params.vm0UserId),
      ),
    )
    .limit(1);

  if (existingVm0Link) {
    if (existingVm0Link.telegramUserId === params.telegramUserId) {
      const userLink = await touchTelegramUserLink(existingVm0Link);
      await publishTelegramUserChangedSafely(params.vm0UserId);
      return {
        ok: true,
        userLink,
      };
    }

    if (
      existingVm0Link.telegramUserId === PENDING_TELEGRAM_USER_ID &&
      params.telegramUserId !== PENDING_TELEGRAM_USER_ID
    ) {
      const [updated] = await globalThis.services.db
        .update(telegramUserLinks)
        .set({
          telegramUserId: params.telegramUserId,
          updatedAt: new Date(),
        })
        .where(eq(telegramUserLinks.id, existingVm0Link.id))
        .returning();

      const userLink = updated ?? existingVm0Link;
      await publishTelegramUserChangedSafely(params.vm0UserId);
      return {
        ok: true,
        userLink,
      };
    }

    return {
      ok: false,
      reason: "vm0-user-linked",
      userLink: existingVm0Link,
    };
  }

  const [inserted] = await globalThis.services.db
    .insert(telegramUserLinks)
    .values({
      telegramUserId: params.telegramUserId,
      installationId: params.installationId,
      vm0UserId: params.vm0UserId,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) {
    await publishTelegramUserChangedSafely(params.vm0UserId);
    return { ok: true, userLink: inserted };
  }

  return { ok: false, reason: "conflict" };
}

/**
 * Build the logs URL for a run, linking to the agent detail logs page.
 */
function buildLogsUrl(runId: string): string {
  return `${getAppUrl()}/activities/${encodeURIComponent(runId)}`;
}

/**
 * Build the agent logs page URL (no specific run).
 */
function buildAgentLogsUrl(): string {
  return `${getAppUrl()}/activities`;
}

export async function resolveTelegramAuditLogsUrl(opts: {
  orgId: string;
  userId: string;
  runId?: string | null;
}): Promise<string | undefined> {
  const overrides = await loadFeatureSwitchOverrides(opts.orgId, opts.userId);
  const enabled = isFeatureEnabled(FeatureSwitchKey.AuditLink, {
    userId: opts.userId,
    orgId: opts.orgId,
    overrides,
  });
  if (!enabled) {
    return undefined;
  }

  return opts.runId ? buildLogsUrl(opts.runId) : buildAgentLogsUrl();
}

/**
 * Look up a user link by telegramUserId and installationId.
 * If no direct match, try to auto-complete a pending link.
 * Returns the user link row or null.
 */
export async function resolveUserLink(
  installationId: string,
  telegramUserId: string,
): Promise<typeof telegramUserLinks.$inferSelect | null> {
  const [userLink] = await globalThis.services.db
    .select()
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.telegramUserId, telegramUserId),
        eq(telegramUserLinks.installationId, installationId),
      ),
    )
    .limit(1);

  if (userLink) {
    return userLink;
  }

  const completed = await completePendingLink(installationId, telegramUserId);
  if (completed) {
    log.info("Auto-completed pending link", {
      installationId,
      telegramUserId,
    });
    return completed;
  }

  return null;
}

/**
 * Complete a pending user link by replacing the placeholder telegramUserId
 * with the real one. Returns the updated row or null if no pending link exists.
 */
async function completePendingLink(
  installationId: string,
  realTelegramUserId: string,
): Promise<typeof telegramUserLinks.$inferSelect | null> {
  const [pending] = await globalThis.services.db
    .select()
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, installationId),
        eq(telegramUserLinks.telegramUserId, PENDING_TELEGRAM_USER_ID),
      ),
    )
    .limit(1);

  if (!pending) {
    return null;
  }

  const result = await linkTelegramUserToVm0User({
    installationId,
    telegramUserId: realTelegramUserId,
    vm0UserId: pending.vm0UserId,
  });

  if (result.ok) {
    return result.userLink;
  }

  log.warn("Failed to auto-complete pending Telegram link", {
    installationId,
    telegramUserId: realTelegramUserId,
    reason: result.reason,
  });
  return null;
}

/**
 * Ensure artifact storage exists for a user within the given org.
 *
 * The caller must resolve and authorize the org before invoking this —
 * we do not re-check membership here.
 */
export async function ensureOrgAndArtifact(
  vm0UserId: string,
  orgId: string,
): Promise<void> {
  await ensureStorageExists(orgId, vm0UserId, "artifact", "artifact");
}

/**
 * Resolve workspace agent name from composeId
 */
export async function getWorkspaceAgent(
  composeId: string,
): Promise<
  | { id: string; name: string; displayName: string | null; agentId: string }
  | undefined
> {
  const db = globalThis.services.db;
  const [compose] = await db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      orgId: agentComposes.orgId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose) return undefined;

  const agentId = await resolveAgentId(compose.orgId, compose.name);
  if (!agentId) return undefined;

  const [agent] = await db
    .select({
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
    })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, agentId))
    .limit(1);

  return {
    id: compose.id,
    name: agent?.name ?? compose.name,
    displayName: agent?.displayName ?? null,
    agentId,
  };
}

export function getAgentDisplayLabel(agent: {
  name: string;
  displayName: string | null;
}): string {
  const displayName = agent.displayName?.trim();
  if (displayName) return displayName;

  const name = agent.name.trim();
  return name || "zero";
}

export async function getWorkspaceAgentDisplayLabel(
  composeId: string,
): Promise<string> {
  const agent = await getWorkspaceAgent(composeId);
  return agent ? getAgentDisplayLabel(agent) : "Zero";
}

function normalizedBotUsername(botUsername: string | null | undefined): string {
  return botUsername?.replace(/^@/, "").trim() ?? "";
}

export function formatTelegramConnectPrompt(
  agentName: string = "Zero",
): string {
  return `To use ${escapeHtml(agentName)} in Telegram, please connect your account first.`;
}

export function buildTelegramConnectReplyMarkup(
  connectUrl: string,
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: "Connect", url: connectUrl }]],
  };
}

export function formatTelegramPrivateConnectPrompt(
  botUsername: string | null | undefined,
  agentName: string = "Zero",
): string {
  const username = normalizedBotUsername(botUsername);
  if (!username) {
    return `${formatTelegramConnectPrompt(agentName)}\n\nSend me /connect in a private message.`;
  }

  return formatTelegramConnectPrompt(agentName);
}

export function buildTelegramPrivateConnectReplyMarkup(
  botUsername: string | null | undefined,
): TelegramInlineKeyboardMarkup | undefined {
  const username = normalizedBotUsername(botUsername);
  if (!username) {
    return undefined;
  }

  return buildTelegramConnectReplyMarkup(
    `https://t.me/${encodeURIComponent(username)}?start=connect`,
  );
}

export function formatTelegramAlreadyConnectedMessage(
  botUsername: string | null | undefined,
  agentName: string = "Zero",
): string {
  const username = normalizedBotUsername(botUsername);
  const target = username
    ? `Mention @${username} in a group or send a DM`
    : "Send a DM";
  return `You are already connected.\n${target} to start chatting with ${agentName}.`;
}

export function formatTelegramCommandSuccess(message: string): string {
  return `✅ ${escapeHtml(message)}`;
}

export function formatTelegramCommandError(message: string): string {
  return `❌ <b>Error</b>\n${escapeHtml(message)}`;
}

export function formatTelegramHelpMessage(
  botUsername: string | null | undefined,
  agentName: string = "Zero",
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
    `• <code>/disconnect</code> - Disconnect from ${label}`,
    "",
    "<b>Usage</b>",
    `${groupUsage}• Send a DM to chat with ${label}`,
  ].join("\n");
}

/**
 * Resolve compose info from an existing session.
 */
export async function resolveSessionCompose(
  sessionId: string,
  userId: string,
): Promise<{ composeId: string; agentName: string } | undefined> {
  const sessionData = await validateAgentSession(sessionId, userId);
  const agent = await getWorkspaceAgent(sessionData.agentComposeId);
  if (agent) {
    return {
      composeId: sessionData.agentComposeId,
      agentName: getAgentDisplayLabel(agent),
    };
  }
  return undefined;
}

/**
 * Build a signed connect URL for unlinked Telegram users.
 * Includes HMAC signature so the platform can verify the link and
 * create the user link with the correct Telegram user ID.
 */
export function buildConnectUrl(
  telegramBotId: string,
  telegramUserId: string,
  botToken: string,
): string {
  const appUrl = getAppUrl();
  const ts = Math.floor(Date.now() / 1000);
  const sig = signConnectParams(telegramBotId, telegramUserId, ts, botToken);
  return `${appUrl}/telegram/connect?bot=${telegramBotId}&tgUser=${telegramUserId}&ts=${ts}&sig=${sig}`;
}

export async function sendTypingAction(
  client: TelegramClient,
  chatId: string | number,
): Promise<void> {
  try {
    await sendChatAction(client, chatId, "typing");
  } catch (err) {
    log.debug("Failed to send typing action", { chatId, error: err });
  }
}

const QUEUED_MESSAGE =
  "⏳ Run queued — concurrency limit reached. Will start automatically when a slot is available.";

/**
 * Send a queued status message when the run could not start immediately.
 */
export async function sendQueuedNotification(
  client: TelegramClient,
  chatId: string | number,
  options?: TelegramSendMessageOptions,
): Promise<void> {
  await sendMessage(client, chatId, QUEUED_MESSAGE, options);
}

/**
 * Format the replied-to message as a quote block to prepend to the prompt.
 * Returns undefined if there's no meaningful reply content.
 */
export function formatReplyQuote(
  replyMessage: TelegramHandlerUpdate["message"]["reply_to_message"],
): string | undefined {
  if (!replyMessage) {
    return undefined;
  }

  const replyText = replyMessage.text ?? replyMessage.caption;
  if (!replyText) {
    return undefined;
  }

  const sender = replyMessage.from?.username
    ? `@${replyMessage.from.username}`
    : (replyMessage.from?.first_name ?? "Unknown");

  return `[Replying to ${sender}]\n> ${replyText}`;
}

/**
 * Return true when a Telegram message has content worth storing or sending to
 * the agent. Telegram Bot API has no history API, so unsupported messages are
 * intentionally ignored instead of creating empty context rows.
 */
export function hasTelegramMessageContextContent(
  message: TelegramContextMessageInput,
): boolean {
  return Boolean(
    message.text ||
    message.caption ||
    hasTelegramFileForContext(message) ||
    extractTelegramMessageEntities(message),
  );
}

/**
 * Append on-demand Telegram file and entity references from the current message.
 */
export function appendTelegramMessageContext(
  prompt: string,
  message: TelegramHandlerUpdate["message"],
  botId: string,
): string {
  const parts: string[] = [];
  const file = extractTelegramFileForContext(message);
  if (file) {
    parts.push(formatTelegramFileForContext(file, { botId }));
  }

  const entities = formatCurrentTelegramEntitiesForPrompt(message);
  if (entities) {
    parts.push(entities);
  }

  if (parts.length === 0) return prompt;
  return prompt ? `${prompt}\n\n${parts.join("\n\n")}` : parts.join("\n\n");
}

/**
 * Enrich a Telegram message with user info while keeping metadata in the
 * system-level Current User Info block.
 *
 * Telegram provides user info directly in the webhook payload (no API call needed).
 */
export function enrichTelegramPrompt(
  prompt: string,
  from: TelegramHandlerUpdate["message"]["from"],
): { prompt: string; userInfoExtras: UserInfoOptions } {
  if (!from) {
    return { prompt, userInfoExtras: {} };
  }

  const displayName = [from.first_name, from.last_name]
    .filter(Boolean)
    .join(" ");

  return {
    prompt,
    userInfoExtras: {
      telegramDisplayName: displayName || undefined,
      telegramUsername: from.username ? `@${from.username}` : undefined,
      telegramUserId: String(from.id),
      telegramLanguage: from.language_code,
    },
  };
}
