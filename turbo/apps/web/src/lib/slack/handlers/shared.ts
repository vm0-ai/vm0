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
import { agentComposes } from "../../../db/schema/agent-compose";
import { zeroAgents } from "../../../db/schema/zero-agent";
import { validateAgentSession } from "../../run";
import { logger } from "../../logger";

const log = logger("slack:shared");

type SlackClient = ReturnType<typeof createSlackClient>;

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

/**
 * Resolve workspace agent from composeId.
 * Returns id, name, and displayName from the zero_agents table.
 */
export async function getWorkspaceAgent(
  composeId: string,
): Promise<
  { id: string; name: string; displayName: string | null } | undefined
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

  const [agent] = await db
    .select({ displayName: zeroAgents.displayName })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.orgId, compose.orgId),
        eq(zeroAgents.name, compose.name),
      ),
    )
    .limit(1);

  return {
    id: compose.id,
    name: compose.name,
    displayName: agent?.displayName ?? null,
  };
}

/**
 * Resolve compose info from an existing session.
 * Used when continuing a conversation to ensure we use the session's agent,
 * not the workspace default.
 */
export async function resolveSessionCompose(
  sessionId: string,
  userId: string,
): Promise<
  | { composeId: string; agentName: string; agentDisplayName: string | null }
  | undefined
> {
  try {
    const sessionData = await validateAgentSession(sessionId, userId);
    const agent = await getWorkspaceAgent(sessionData.agentComposeId);
    if (agent) {
      return {
        composeId: sessionData.agentComposeId,
        agentName: agent.name,
        agentDisplayName: agent.displayName,
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
  const userInfo = await fetchSlackUserInfo(opts.client, opts.userId);
  if (userInfo) {
    content = `[Slack User]\n${userInfo}\n\n${content}`;
  }

  return content;
}
