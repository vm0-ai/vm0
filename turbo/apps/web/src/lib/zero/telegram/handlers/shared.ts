import { eq, and } from "drizzle-orm";
import { telegramThreadSessions } from "../../../../db/schema/telegram-thread-session";
import { telegramMessages } from "../../../../db/schema/telegram-message";
import { telegramUserLinks } from "../../../../db/schema/telegram-user-link";
import { agentComposes } from "../../../../db/schema/agent-compose";
import { getAppUrl } from "../../url";
import { resolveAgentId } from "../../zero-compose-service";
import { resolveOrgOrNull } from "../../org/resolve-org";
import { validateAgentSession } from "../../zero-run-validation";
import { ensureStorageExists } from "../../../infra/storage/storage-service";
import {
  sendMessage,
  editMessageText,
  type TelegramClient,
  type TelegramSentMessage,
} from "../client";
import { escapeHtml } from "../format";
import { signConnectParams } from "../connect-token";
import {
  pickBestPhoto,
  downloadAndUploadTelegramPhoto,
  formatPhotoForContext,
} from "../images";
import { logger } from "../../../shared/logger";
import type { TelegramHandlerUpdate } from "./types";

const log = logger("telegram:shared");

/**
 * Sentinel value for a pending user link that hasn't been claimed yet.
 * Set as telegramUserId at link time, replaced with the real
 * Telegram user ID when the user sends their first message.
 */
export const PENDING_TELEGRAM_USER_ID = "pending";

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
 * For photo messages, stores the caption as text and the best photo's file_id.
 */
export async function storeTelegramMessage(
  installationId: string,
  chatId: string,
  message: {
    message_id: number;
    from?: { id: number; username?: string; is_bot?: boolean };
    text?: string;
    caption?: string;
    photo?: Array<{
      file_id: string;
      width: number;
      height: number;
      file_size?: number;
    }>;
  },
): Promise<void> {
  const bestPhoto = message.photo ? pickBestPhoto(message.photo) : undefined;

  await globalThis.services.db
    .insert(telegramMessages)
    .values({
      installationId,
      chatId,
      messageId: String(message.message_id),
      fromUserId: String(message.from?.id ?? 0),
      fromUsername: message.from?.username ?? null,
      text: message.text ?? message.caption ?? null,
      fileId: bestPhoto?.file_id ?? null,
      isBot: message.from?.is_bot ?? false,
    })
    .onConflictDoNothing();
}

/**
 * Build the logs URL for a run, linking to the agent detail logs page.
 */
export function buildLogsUrl(runId: string): string {
  return `${getAppUrl()}/activity/${encodeURIComponent(runId)}`;
}

/**
 * Build the agent logs page URL (no specific run).
 */
export function buildAgentLogsUrl(): string {
  return `${getAppUrl()}/activity`;
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
  const [updated] = await globalThis.services.db
    .update(telegramUserLinks)
    .set({
      telegramUserId: realTelegramUserId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(telegramUserLinks.installationId, installationId),
        eq(telegramUserLinks.telegramUserId, PENDING_TELEGRAM_USER_ID),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Ensure org and artifact storage exist for a user.
 */
export async function ensureOrgAndArtifact(vm0UserId: string): Promise<void> {
  const org = await resolveOrgOrNull({ userId: vm0UserId });
  if (!org) return;

  await ensureStorageExists(org.orgId, vm0UserId, "artifact", "artifact");
}

/**
 * Resolve workspace agent name from composeId
 */
export async function getWorkspaceAgent(
  composeId: string,
): Promise<{ id: string; name: string; agentId: string } | undefined> {
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

  return {
    id: compose.id,
    name: compose.name,
    agentId,
  };
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
      agentName: agent.name,
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
  installationId: string,
  telegramBotId: string,
  telegramUserId: string,
  botToken: string,
): string {
  const appUrl = getAppUrl();
  const ts = Math.floor(Date.now() / 1000);
  const sig = signConnectParams(installationId, telegramUserId, ts, botToken);
  return `${appUrl}/telegram/connect?bot=${telegramBotId}&tgUser=${telegramUserId}&ts=${ts}&sig=${sig}`;
}

/**
 * Send a thinking placeholder message that persists until the agent responds.
 * Returns the sent message so its ID can be passed to the callback for deletion.
 */
export async function sendThinkingMessage(
  client: TelegramClient,
  chatId: string | number,
  agentName: string,
  options?: { replyToMessageId?: number },
): Promise<TelegramSentMessage | undefined> {
  const text = `<i>🤖 ${escapeHtml(agentName)} is thinking...</i>`;
  try {
    return await sendMessage(client, chatId, text, options);
  } catch (err) {
    log.warn("Failed to send thinking message", { chatId, error: err });
    return undefined;
  }
}

const QUEUED_MESSAGE =
  "⏳ Run queued — concurrency limit reached. Will start automatically when a slot is available.";

/**
 * Update the thinking message to show queued status, or send a new message if
 * no thinking message exists.
 */
export async function sendQueuedNotification(
  client: TelegramClient,
  chatId: string | number,
  thinkingMessage: TelegramSentMessage | undefined,
  options?: { replyToMessageId?: number },
): Promise<void> {
  if (thinkingMessage) {
    await editMessageText(
      client,
      chatId,
      thinkingMessage.message_id,
      QUEUED_MESSAGE,
    );
  } else {
    await sendMessage(client, chatId, QUEUED_MESSAGE, options);
  }
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
 * Append photo context to the prompt if the message contains a photo.
 * Handles picking the best resolution, downloading, uploading, and formatting.
 */
export async function appendPhotoContext(
  prompt: string,
  message: TelegramHandlerUpdate["message"],
  client: TelegramClient,
  installationId: string,
  chatId: string,
): Promise<string> {
  if (!message.photo) {
    return prompt;
  }
  const bestPhoto = pickBestPhoto(message.photo);
  if (!bestPhoto) {
    return prompt;
  }
  const presignedUrl = await downloadAndUploadTelegramPhoto(
    client,
    bestPhoto.file_id,
    `${installationId}-${chatId}`,
  );
  if (!presignedUrl) {
    return prompt;
  }
  return `${prompt}\n\n${formatPhotoForContext(presignedUrl, bestPhoto)}`;
}

/**
 * Enrich a Telegram message prompt with user info, matching Slack's
 * `enrichMessageContent` pattern that prepends `[Slack User]\n...`.
 *
 * Telegram provides user info directly in the webhook payload (no API call needed).
 */
export function enrichTelegramPrompt(
  prompt: string,
  from: TelegramHandlerUpdate["message"]["from"],
): string {
  if (!from) {
    return prompt;
  }

  const parts: string[] = [];
  parts.push(`Telegram User ID: ${from.id}`);

  const displayName = [from.first_name, from.last_name]
    .filter(Boolean)
    .join(" ");
  if (displayName) {
    parts.push(`Name: ${displayName}`);
  }
  if (from.username) {
    parts.push(`Username: @${from.username}`);
  }
  if (from.language_code) {
    parts.push(`Language: ${from.language_code}`);
  }

  return `[Telegram User]\n${parts.join("\n")}\n\n${prompt}`;
}
