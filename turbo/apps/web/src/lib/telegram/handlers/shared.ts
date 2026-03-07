import { eq, and } from "drizzle-orm";
import { telegramThreadSessions } from "../../../db/schema/telegram-thread-session";
import { telegramMessages } from "../../../db/schema/telegram-message";
import { telegramUserLinks } from "../../../db/schema/telegram-user-link";
import { agentComposes } from "../../../db/schema/agent-compose";
import { getPlatformUrl } from "../../url";
import {
  getUserScopeByClerkId,
  createScope,
  generateDefaultScopeSlug,
} from "../../scope/scope-service";
import { validateAgentSession } from "../../run";
import { ensureArtifactExists } from "../../storage/storage-service";
import {
  sendMessage,
  type TelegramClient,
  type TelegramSentMessage,
} from "../client";
import { escapeHtml } from "../format";
import { logger } from "../../logger";

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
 */
export async function storeTelegramMessage(
  installationId: string,
  chatId: string,
  message: {
    message_id: number;
    from?: { id: number; username?: string; is_bot?: boolean };
    text?: string;
  },
): Promise<void> {
  await globalThis.services.db
    .insert(telegramMessages)
    .values({
      installationId,
      chatId,
      messageId: String(message.message_id),
      fromUserId: String(message.from?.id ?? 0),
      fromUsername: message.from?.username ?? null,
      text: message.text ?? null,
      isBot: message.from?.is_bot ?? false,
    })
    .onConflictDoNothing();
}

/**
 * Build the logs URL for a run, linking to the agent detail logs page.
 */
export function buildLogsUrl(runId: string, agentName: string): string {
  return `${getPlatformUrl()}/agents/${encodeURIComponent(agentName)}/logs/${encodeURIComponent(runId)}`;
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
 * Ensure scope and artifact storage exist for a user.
 */
export async function ensureScopeAndArtifact(vm0UserId: string): Promise<void> {
  let scope = await getUserScopeByClerkId(vm0UserId);
  if (!scope) {
    scope = await createScope(vm0UserId, generateDefaultScopeSlug(vm0UserId));
    log.info("Auto-created scope for Telegram user", { userId: vm0UserId });
  }

  await ensureArtifactExists(scope.id, vm0UserId, "artifact", scope.slug);
}

/**
 * Resolve workspace agent name from composeId
 */
export async function getWorkspaceAgent(
  composeId: string,
): Promise<{ id: string; name: string } | undefined> {
  const [compose] = await globalThis.services.db
    .select({ id: agentComposes.id, name: agentComposes.name })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  return compose ?? undefined;
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
