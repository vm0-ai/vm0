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
