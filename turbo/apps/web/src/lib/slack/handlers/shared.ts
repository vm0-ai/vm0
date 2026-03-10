import { eq, and } from "drizzle-orm";
import { createSlackClient, fetchSlackUserInfo } from "../client";
import {
  fetchThreadContext,
  fetchChannelContext,
  formatContextForAgent,
  formatContextForAgentWithImages,
  formatCurrentMessageFiles,
  type SlackFile,
} from "../context";
import { slackThreadSessions } from "../../../db/schema/slack-thread-session";
import { agentComposes } from "../../../db/schema/agent-compose";
import { getPlatformUrl } from "../../url";
import { ensureDefaultScope } from "../../scope/scope-service";
import { validateAgentSession } from "../../run";
import { ensureStorageExists } from "../../storage/storage-service";
import { logger } from "../../logger";

const log = logger("slack:shared");

export type SlackClient = ReturnType<typeof createSlackClient>;

/**
 * Remove the thinking reaction from a message
 */
export async function removeThinkingReaction(
  client: SlackClient,
  channelId: string,
  messageTs: string,
): Promise<void> {
  await client.reactions
    .remove({
      channel: channelId,
      timestamp: messageTs,
      name: "thought_balloon",
    })
    .catch(() => {
      // Ignore errors when removing reaction
    });
}

/**
 * Fetch conversation context with deduplication support.
 * Returns separate contexts for routing (text-only, full history) and
 * execution (with images, only new messages since lastProcessedMessageTs).
 *
 * Single Slack API call — messages are fetched once and filtered in-memory.
 */
export async function fetchConversationContexts(
  client: SlackClient,
  channelId: string,
  threadTs: string | undefined,
  botUserId: string,
  botToken: string,
  lastProcessedMessageTs?: string,
  currentMessageTs?: string,
): Promise<{ routingContext: string; executionContext: string }> {
  const imageSessionId = `${channelId}-${threadTs ?? "channel"}`;
  const contextType = threadTs ? "thread" : "channel";

  // Fetch all messages once (single Slack API call)
  const allMessages = threadTs
    ? await fetchThreadContext(client, channelId, threadTs)
    : await fetchChannelContext(client, channelId, 10);

  // Exclude the current message (it's already sent as the prompt)
  const contextMessages = currentMessageTs
    ? allMessages.filter((m) => m.ts !== currentMessageTs)
    : allMessages;

  // Text-only full context for routing (no image uploads needed)
  const routingContext = formatContextForAgent(
    contextMessages,
    botUserId,
    contextType,
  );

  // Filter to only new messages for execution context
  const executionMessages = lastProcessedMessageTs
    ? contextMessages.filter((m) => !m.ts || m.ts > lastProcessedMessageTs)
    : contextMessages;

  // Format execution context with images (only uploads images for new messages)
  const executionContext =
    executionMessages.length > 0
      ? await formatContextForAgentWithImages(
          executionMessages,
          botToken,
          imageSessionId,
          botUserId,
          contextType,
        )
      : "";

  return { routingContext, executionContext };
}

interface ThreadSessionLookup {
  existingSessionId: string | undefined;
  lastProcessedMessageTs: string | undefined;
}

/**
 * Look up an existing thread session by channel + thread + user link.
 */
export async function lookupThreadSession(
  channelId: string,
  threadTs: string,
  userLinkId: string,
): Promise<ThreadSessionLookup> {
  const [session] = await globalThis.services.db
    .select({
      agentSessionId: slackThreadSessions.agentSessionId,
      lastProcessedMessageTs: slackThreadSessions.lastProcessedMessageTs,
    })
    .from(slackThreadSessions)
    .where(
      and(
        eq(slackThreadSessions.slackUserLinkId, userLinkId),
        eq(slackThreadSessions.slackChannelId, channelId),
        eq(slackThreadSessions.slackThreadTs, threadTs),
      ),
    )
    .limit(1);

  return {
    existingSessionId: session?.agentSessionId,
    lastProcessedMessageTs: session?.lastProcessedMessageTs ?? undefined,
  };
}

/**
 * Create or update a thread session mapping after agent execution.
 */
export async function saveThreadSession(opts: {
  userLinkId: string;
  channelId: string;
  threadTs: string;
  existingSessionId: string | undefined;
  newSessionId: string | undefined;
  messageTs: string;
  runStatus: string;
}): Promise<void> {
  const {
    userLinkId,
    channelId,
    threadTs,
    existingSessionId,
    newSessionId,
    messageTs,
    runStatus,
  } = opts;

  if (!existingSessionId && newSessionId) {
    // New thread — create mapping
    await globalThis.services.db
      .insert(slackThreadSessions)
      .values({
        slackUserLinkId: userLinkId,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        agentSessionId: newSessionId,
        lastProcessedMessageTs: messageTs,
      })
      .onConflictDoNothing();
  } else if (
    existingSessionId &&
    (runStatus === "completed" || runStatus === "timeout")
  ) {
    // Existing thread, successful run — update lastProcessedMessageTs
    await globalThis.services.db
      .update(slackThreadSessions)
      .set({
        lastProcessedMessageTs: messageTs,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(slackThreadSessions.slackUserLinkId, userLinkId),
          eq(slackThreadSessions.slackChannelId, channelId),
          eq(slackThreadSessions.slackThreadTs, threadTs),
        ),
      );
  }
  // Failed runs — do not update lastProcessedMessageTs (allows retry with same context)
}

/**
 * Build the login URL
 */
export function buildLoginUrl(
  workspaceId: string,
  slackUserId: string,
  channelId: string,
): string {
  const baseUrl = getPlatformUrl();
  const params = new URLSearchParams({
    w: workspaceId,
    u: slackUserId,
    c: channelId,
  });
  return `${baseUrl}/slack/connect?${params.toString()}`;
}

/**
 * Build the logs URL for a run, linking to the agent detail logs page.
 */
export function buildLogsUrl(runId: string, agentName: string): string {
  return `${getPlatformUrl()}/agents/${encodeURIComponent(agentName)}/logs/${encodeURIComponent(runId)}`;
}

/**
 * Build the agent-level logs URL (no specific run).
 * Used as fallback when runId is unavailable (e.g. dispatch failure).
 */
export function buildAgentLogsUrl(agentName: string): string {
  return `${getPlatformUrl()}/agents/${encodeURIComponent(agentName)}/logs`;
}

/**
 * Ensure scope and artifact storage exist for a user.
 * Safety net for all agent link paths (App Home button, slash command, submission).
 *
 * Follows the same prepare/commit pattern as `vm0 cook`:
 * 1. Find-or-create storage record
 * 2. If no HEAD version, create an empty initial version (upload manifest to S3 + commit)
 */
export async function ensureScopeAndArtifact(vm0UserId: string): Promise<void> {
  const scope = await ensureDefaultScope(vm0UserId);

  // Preserve original Slack behavior: log but don't throw on artifact creation failure.
  // Slack callers (server actions, OAuth callback) don't have error handling for this.
  try {
    await ensureStorageExists(
      scope.clerkOrgId,
      vm0UserId,
      "artifact",
      scope.slug,
      "artifact",
      scope.id,
    );
  } catch (err) {
    log.error("Failed to ensure artifact exists for Slack user", {
      userId: vm0UserId,
      err,
    });
  }
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
 * Used when continuing a conversation to ensure we use the session's agent,
 * not the workspace default.
 */
export async function resolveSessionCompose(
  sessionId: string,
  userId: string,
): Promise<{ composeId: string; agentName: string } | undefined> {
  try {
    const sessionData = await validateAgentSession(sessionId, userId);
    const agent = await getWorkspaceAgent(sessionData.agentComposeId);
    if (agent) {
      return {
        composeId: sessionData.agentComposeId,
        agentName: agent.name,
      };
    }
  } catch (error) {
    log.warn("Failed to resolve session compose, using workspace default", {
      sessionId,
      error,
    });
  }
  return undefined;
}

/**
 * Enrich message content with file attachments and Slack user info.
 * Shared between direct-message and mention handlers.
 */
export async function enrichMessageContent(opts: {
  messageContent: string;
  files: SlackFile[] | undefined;
  botToken: string;
  channelId: string;
  threadTs: string;
  client: SlackClient;
  userId: string;
}): Promise<string> {
  let content = opts.messageContent;

  // Include files attached to the current message in the prompt
  if (opts.files && opts.files.length > 0) {
    const imageSessionId = `${opts.channelId}-${opts.threadTs}`;
    const filesText = await formatCurrentMessageFiles(
      opts.files,
      opts.botToken,
      imageSessionId,
    );
    content = `${content}\n\n${filesText}`;
  }

  // Prepend Slack user info to the prompt
  const userInfo = await fetchSlackUserInfo(opts.client, opts.userId).catch(
    (err) => {
      log.warn("Failed to fetch Slack user info", {
        userId: opts.userId,
        error: err,
      });
      return undefined;
    },
  );
  if (userInfo) {
    content = `[Slack User]\n${userInfo}\n\n${content}`;
  }

  return content;
}
