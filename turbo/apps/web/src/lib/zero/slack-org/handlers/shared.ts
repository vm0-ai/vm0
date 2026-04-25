import { eq, and } from "drizzle-orm";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgThreadSessions } from "@vm0/db/schema/slack-org-thread-session";
import { slackUserAgentPreferences } from "@vm0/db/schema/slack-user-agent-preference";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { orgMetadata as orgTable } from "@vm0/db/schema/org-metadata";
import { getAppUrl } from "../../url";
import { resolveDefaultAgentComposeId } from "../../../infra/agent-compose/resolve-default";
import { ensureStorageExists } from "../../../infra/storage/storage-service";
import { createSlackClient, fetchSlackUserInfoMap } from "../../slack/client";
import type { UserInfoOptions } from "../../integration-prompt";
import {
  fetchThreadContext,
  fetchChannelContext,
  formatContextForAgent,
  formatCurrentMessageFiles,
  extractMentionedUserIds,
  resolveUserMentions,
  type SlackFile,
} from "../../slack/context";
import { validateAgentSession } from "../../zero-run-validation";
import { logger } from "../../../shared/logger";

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
 * Since zero_agents.id = composeId, defaultAgentId IS the composeId.
 * Falls back to VM0_DEFAULT_AGENT env var.
 */
export async function resolveDefaultComposeId(
  orgId: string,
): Promise<string | null> {
  const [orgRow] = await globalThis.services.db
    .select({ defaultAgentId: orgTable.defaultAgentId })
    .from(orgTable)
    .where(eq(orgTable.orgId, orgId))
    .limit(1);

  if (orgRow?.defaultAgentId) return orgRow.defaultAgentId;

  return resolveDefaultAgentComposeId();
}

/**
 * Resolve the user's agent override, or null when no override is set.
 */
export async function getUserAgentPreference(
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const [row] = await globalThis.services.db
    .select({ selectedComposeId: slackUserAgentPreferences.selectedComposeId })
    .from(slackUserAgentPreferences)
    .where(
      and(
        eq(slackUserAgentPreferences.vm0UserId, vm0UserId),
        eq(slackUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);

  return row?.selectedComposeId ?? null;
}

/**
 * Persist (or clear) a user's agent override.
 *
 * Passing `null` for `composeId` clears the override so the user reverts to
 * the org default.
 */
export async function setUserAgentPreference(opts: {
  vm0UserId: string;
  orgId: string;
  composeId: string | null;
}): Promise<void> {
  await globalThis.services.db
    .insert(slackUserAgentPreferences)
    .values({
      vm0UserId: opts.vm0UserId,
      orgId: opts.orgId,
      selectedComposeId: opts.composeId,
    })
    .onConflictDoUpdate({
      target: [
        slackUserAgentPreferences.vm0UserId,
        slackUserAgentPreferences.orgId,
      ],
      set: {
        selectedComposeId: opts.composeId,
        updatedAt: new Date(),
      },
    });
}

/**
 * Resolve the compose that should respond for this user.
 *
 * Resolution order:
 *   1. If a row exists in `slack_user_agent_preferences` and its
 *      `selectedComposeId` still points to an agent that (a) exists and
 *      (b) belongs to the given org, use it. The org check is a stale-pointer
 *      guard: an override can linger after the target compose is deleted,
 *      archived, or moved to a different org, and silently falling back to
 *      the default is preferable to returning a stale/unauthorized agent.
 *   2. Otherwise return the org default compose id (may be null if the org
 *      has no default configured — callers must handle that).
 *
 * This function is called by the mention / DM / App Home handlers; it must
 * stay cheap (single indexed read + optional zero_agents lookup).
 */
export async function resolveEffectiveComposeId(
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const override = await getUserAgentPreference(vm0UserId, orgId);
  if (override) {
    const [row] = await globalThis.services.db
      .select({ id: zeroAgents.id })
      .from(zeroAgents)
      .where(and(eq(zeroAgents.id, override), eq(zeroAgents.orgId, orgId)))
      .limit(1);
    if (row?.id) {
      return override;
    }
  }
  return resolveDefaultComposeId(orgId);
}

/**
 * Look up an existing thread session.
 */
export async function lookupThreadSession(
  channelId: string,
  threadTs: string,
  connectionId: string,
): Promise<{
  existingSessionId: string | undefined;
}> {
  const [session] = await globalThis.services.db
    .select({
      agentSessionId: slackOrgThreadSessions.agentSessionId,
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
  runStatus: string;
}): Promise<void> {
  const {
    connectionId,
    channelId,
    threadTs,
    existingSessionId,
    newSessionId,
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
      })
      .onConflictDoUpdate({
        target: [
          slackOrgThreadSessions.connectionId,
          slackOrgThreadSessions.slackChannelId,
          slackOrgThreadSessions.slackThreadTs,
        ],
        set: {
          agentSessionId,
          updatedAt: new Date(),
        },
      });
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
  return `${appUrl}/settings/slack?${params.toString()}`;
}

/**
 * Ensure artifact storage exists for a user in a specific org.
 * Unlike the legacy version, this takes explicit org context.
 */
export async function ensureOrgArtifact(
  userId: string,
  orgId: string,
): Promise<void> {
  await ensureStorageExists(orgId, userId, "artifact", "artifact");
}

const log = logger("slack:shared");

type SlackClient = ReturnType<typeof createSlackClient>;

/**
 * Fetch conversation context for the agent.
 * Always returns the full thread context so the agent has complete awareness
 * of the Slack conversation, even when resuming an existing session.
 *
 * Single Slack API call — messages are fetched once.
 */
export async function fetchConversationContexts(
  client: SlackClient,
  channelId: string,
  threadTs: string | undefined,
  currentMessageTs?: string,
): Promise<{ executionContext: string }> {
  const isDm = channelId.startsWith("D");
  const contextType = threadTs ? "thread" : "channel";

  // Fetch all messages once (single Slack API call)
  // DMs without a thread don't need channel context — the current message is
  // already the full conversation context.
  const allMessages = threadTs
    ? await fetchThreadContext(client, channelId, threadTs)
    : isDm
      ? []
      : await fetchChannelContext(client, channelId, 10);

  // For thread mentions in a non-DM channel, fetch the 10 channel messages
  // before the thread so the agent has background context.
  // DMs don't need channel history — the thread already contains the full conversation.
  const channelMessages =
    threadTs && !isDm
      ? await fetchChannelContext(client, channelId, 10, threadTs)
      : [];

  // Exclude the current message (it's already sent as the prompt)
  const contextMessages = currentMessageTs
    ? allMessages.filter((m) => {
        return m.ts !== currentMessageTs;
      })
    : allMessages;

  // Resolve user info for all senders and mentioned users
  const allContextMessages = [...channelMessages, ...allMessages];
  const senderIds = allContextMessages.flatMap((m) => {
    return m.user && !m.bot_id ? [m.user] : [];
  });
  const mentionedIds = extractMentionedUserIds(allContextMessages);
  const userIds = [...senderIds, ...mentionedIds];
  const userInfoMap = await fetchSlackUserInfoMap(client, userIds);

  // Format channel context prefix — files are rendered as download instructions,
  // not fetched server-side.
  const channelContextPrefix =
    channelMessages.length > 0
      ? formatContextForAgent(channelMessages, "channel", userInfoMap)
      : "";

  // Format thread/channel context
  const threadExecContext =
    contextMessages.length > 0
      ? formatContextForAgent(contextMessages, contextType, userInfoMap)
      : "";
  const executionContext = channelContextPrefix
    ? `${channelContextPrefix}\n\n${threadExecContext}`
    : threadExecContext;

  return { executionContext };
}

/**
 * Resolve workspace agent from composeId (= zeroAgents.id).
 * Returns id, name, and displayName from the zero_agents table.
 */
export async function getWorkspaceAgent(composeId: string): Promise<
  | {
      id: string;
      name: string;
      displayName: string | null;
      agentId: string;
    }
  | undefined
> {
  const db = globalThis.services.db;
  const [agent] = await db
    .select({
      id: zeroAgents.id,
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
    })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, composeId))
    .limit(1);

  if (!agent) return undefined;

  return {
    id: agent.id,
    name: agent.name,
    displayName: agent.displayName,
    agentId: agent.id,
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
 *
 * File descriptions ([Slack file] blocks) are appended to the prompt so the
 * agent sees them as part of the user message. The agent learns how to
 * download via `zero slack download-file -h`.
 */
export async function enrichMessageContent(opts: {
  messageContent: string;
  files: SlackFile[] | undefined;
  client: SlackClient;
  userId: string;
}): Promise<{ prompt: string; userInfoExtras: UserInfoOptions }> {
  let prompt = opts.messageContent;

  // Append file descriptions to prompt
  if (opts.files && opts.files.length > 0) {
    const filesText = formatCurrentMessageFiles(opts.files);
    prompt = `${prompt}\n\n${filesText}`;
  }

  // Resolve user mentions and current user info
  const mentionedIds = extractMentionedUserIds([{ text: opts.messageContent }]);
  const allIds = [opts.userId, ...mentionedIds];
  const userInfoMap = await fetchSlackUserInfoMap(opts.client, allIds);

  // Resolve mentions in prompt text
  prompt = resolveUserMentions(prompt, userInfoMap);

  // Build Slack-specific user info extras (base user info is injected by createZeroRunRecord)
  const currentUser = userInfoMap.get(opts.userId);
  const userInfoExtras: UserInfoOptions = currentUser
    ? {
        slackDisplayName: currentUser.name,
        slackUserId: currentUser.id,
      }
    : {};

  return { prompt, userInfoExtras };
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
