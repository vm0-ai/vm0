import { eq, and } from "drizzle-orm";
import { slackUserAgentPreferences } from "@vm0/db/schema/slack-user-agent-preference";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { orgMetadata as orgTable } from "@vm0/db/schema/org-metadata";
import { getAppUrl } from "../../url";
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

/**
 * Resolve default agent compose ID from org table.
 * Since zero_agents.id = composeId, defaultAgentId IS the composeId.
 */
export async function resolveDefaultComposeId(
  orgId: string,
): Promise<string | null> {
  const [orgRow] = await globalThis.services.db
    .select({ defaultAgentId: orgTable.defaultAgentId })
    .from(orgTable)
    .where(eq(orgTable.orgId, orgId))
    .limit(1);

  return orgRow?.defaultAgentId ?? null;
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
  return `${getAppUrl()}/activities/${encodeURIComponent(runId)}`;
}

/**
 * Build the agent-level activity URL (no specific run).
 */
export function buildAgentLogsUrl(): string {
  return `${getAppUrl()}/activities`;
}
