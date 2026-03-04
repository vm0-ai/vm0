import { eq, and } from "drizzle-orm";
import { telegramThreadSessions } from "../../../db/schema/telegram-thread-session";
import { telegramMessages } from "../../../db/schema/telegram-message";
import { agentComposes } from "../../../db/schema/agent-compose";
import { getPlatformUrl } from "../../url";
import {
  getUserScopeByClerkId,
  createUserScope,
  generateDefaultScopeSlug,
} from "../../scope/scope-service";
import { validateAgentSession } from "../../run";
import { ensureArtifactExists } from "../../storage/storage-service";
import { logger } from "../../logger";

const log = logger("telegram:shared");

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
  existingSessionId: string | undefined;
  newSessionId: string | undefined;
  messageId: string;
  runStatus: string;
}): Promise<void> {
  const {
    userLinkId,
    chatId,
    rootMessageId,
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
    // Existing thread, successful run — update lastProcessedMessageId
    await globalThis.services.db
      .update(telegramThreadSessions)
      .set({
        lastProcessedMessageId: messageId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(telegramThreadSessions.telegramUserLinkId, userLinkId),
          eq(telegramThreadSessions.chatId, chatId),
          eq(telegramThreadSessions.rootMessageId, rootMessageId),
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
 * Build the deep link URL for account linking
 */
export function buildLoginUrl(botUsername: string, linkToken: string): string {
  return `https://t.me/${botUsername}?start=${linkToken}`;
}

/**
 * Build the logs URL for a run
 */
export function buildLogsUrl(runId: string): string {
  return `${getPlatformUrl()}/logs/${runId}`;
}

/**
 * Ensure scope and artifact storage exist for a user.
 */
export async function ensureScopeAndArtifact(vm0UserId: string): Promise<void> {
  let scope = await getUserScopeByClerkId(vm0UserId);
  if (!scope) {
    scope = await createUserScope(
      vm0UserId,
      generateDefaultScopeSlug(vm0UserId),
    );
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
