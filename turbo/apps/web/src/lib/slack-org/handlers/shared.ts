import { eq, and } from "drizzle-orm";
import { slackOrgInstallations } from "../../../db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../db/schema/slack-org-connection";
import { slackOrgThreadSessions } from "../../../db/schema/slack-org-thread-session";
import { agentComposes } from "../../../db/schema/agent-compose";
import { zeroAgents } from "../../../db/schema/zero-agent";
import { org as orgTable } from "../../../db/schema/org";
import { getAppUrl } from "../../url";
import { resolveDefaultAgentComposeId } from "../../agent-compose/resolve-default";
import { ensureStorageExists } from "../../storage/storage-service";
import { createSlackClient, fetchSlackUserInfo } from "../../slack/client";
import {
  fetchThreadContext,
  fetchChannelContext,
  formatContextForAgent,
  formatContextForAgentWithImages,
  formatCurrentMessageFiles,
  type SlackFile,
} from "../../slack/context";
import { validateAgentSession } from "../../run";
import { logger } from "../../logger";

/**
 * Resolve installation and org from a Slack workspace ID.
 * Returns null if the workspace is not installed or not bound to an org.
 */
export async function resolveOrgFromWorkspace(workspaceId: string): Promise<{
  installation: typeof slackOrgInstallations.$inferSelect;
  orgId: string;
} | null> {
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation?.orgId) {
    return null;
  }

  return { installation, orgId: installation.orgId };
}

/**
 * Resolve a connection from a Slack user in a workspace.
 */
export async function resolveConnectionFromSlackUser(
  slackUserId: string,
  workspaceId: string,
): Promise<typeof slackOrgConnections.$inferSelect | null> {
  const [connection] = await globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, slackUserId),
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);

  return connection ?? null;
}

/**
 * Resolve default agent compose ID from org table.
 * Falls back to VM0_DEFAULT_AGENT env var if not set.
 */
export async function resolveDefaultComposeId(
  orgId: string,
): Promise<string | null> {
  const [orgRow] = await globalThis.services.db
    .select({ defaultAgentComposeId: orgTable.defaultAgentComposeId })
    .from(orgTable)
    .where(eq(orgTable.orgId, orgId))
    .limit(1);

  if (orgRow?.defaultAgentComposeId) {
    return orgRow.defaultAgentComposeId;
  }

  // Fallback: resolve from VM0_DEFAULT_AGENT env var
  return resolveDefaultAgentComposeId();
}

/**
 * Look up an existing thread session for deduplication.
 */
export async function lookupThreadSession(
  channelId: string,
  threadTs: string,
  connectionId: string,
): Promise<{
  existingSessionId: string | undefined;
  lastProcessedMessageTs: string | undefined;
}> {
  const [session] = await globalThis.services.db
    .select({
      agentSessionId: slackOrgThreadSessions.agentSessionId,
      lastProcessedMessageTs: slackOrgThreadSessions.lastProcessedMessageTs,
    })
    .from(slackOrgThreadSessions)
    .where(
      and(
        eq(slackOrgThreadSessions.connectionId, connectionId),
        eq(slackOrgThreadSessions.slackChannelId, channelId),
        eq(slackOrgThreadSessions.slackThreadTs, threadTs),
      ),
    )
    .limit(1);

  return {
    existingSessionId: session?.agentSessionId ?? undefined,
    lastProcessedMessageTs: session?.lastProcessedMessageTs ?? undefined,
  };
}

/**
 * Save or update a thread session mapping after agent execution.
 */
export async function saveThreadSession(opts: {
  connectionId: string;
  channelId: string;
  threadTs: string;
  existingSessionId: string | undefined;
  newSessionId: string | undefined;
  messageTs: string;
  runStatus: string;
}): Promise<void> {
  const {
    connectionId,
    channelId,
    threadTs,
    existingSessionId,
    newSessionId,
    messageTs,
    runStatus,
  } = opts;

  const agentSessionId = newSessionId ?? existingSessionId;

  // Skip update on failed runs — allows retry with same context
  if (runStatus === "failed") {
    return;
  }

  if (!existingSessionId && agentSessionId) {
    // Create new mapping
    await globalThis.services.db
      .insert(slackOrgThreadSessions)
      .values({
        connectionId,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        agentSessionId,
        lastProcessedMessageTs: messageTs,
      })
      .onConflictDoUpdate({
        target: [
          slackOrgThreadSessions.connectionId,
          slackOrgThreadSessions.slackChannelId,
          slackOrgThreadSessions.slackThreadTs,
        ],
        set: {
          agentSessionId,
          lastProcessedMessageTs: messageTs,
          updatedAt: new Date(),
        },
      });
  } else if (existingSessionId) {
    // Update existing mapping
    await globalThis.services.db
      .update(slackOrgThreadSessions)
      .set({
        lastProcessedMessageTs: messageTs,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(slackOrgThreadSessions.connectionId, connectionId),
          eq(slackOrgThreadSessions.slackChannelId, channelId),
          eq(slackOrgThreadSessions.slackThreadTs, threadTs),
        ),
      );
  }
}

/**
 * Build the org connect URL for Slack users.
 */
export function buildOrgConnectUrl(
  workspaceId: string,
  slackUserId: string,
  channelId: string,
  threadTs?: string,
): string {
  const appUrl = getAppUrl();
  const params = new URLSearchParams({
    w: workspaceId,
    u: slackUserId,
  });
  if (channelId) {
    params.set("c", channelId);
  }
  if (threadTs) {
    params.set("t", threadTs);
  }
  return `${appUrl}/slack/connect?${params.toString()}`;
}

/**
 * Ensure artifact storage exists for a user in a specific org.
 * Unlike the legacy version, this takes explicit org context.
 */
export async function ensureOrgArtifact(
  userId: string,
  orgId: string,
  orgSlug: string,
): Promise<void> {
  await ensureStorageExists(orgId, userId, "artifact", orgSlug, "artifact");
}

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

/**
 * Build the logs URL for a run in the org flow.
 */
export function buildLogsUrl(runId: string): string {
  return `${getAppUrl()}/activity/${encodeURIComponent(runId)}`;
}

/**
 * Build the agent-level activity URL (no specific run).
 */
export function buildAgentLogsUrl(): string {
  return `${getAppUrl()}/activity`;
}
