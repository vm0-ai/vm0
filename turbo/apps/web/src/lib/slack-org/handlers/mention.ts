import { decryptSecretValue } from "../../crypto/secrets-encryption";
import { env } from "../../../env";
import { createSlackClient, setThreadStatus } from "../../slack/client";
import {
  buildAgentResponseMessage,
  buildLoginPromptMessage,
  detectDeepLinks,
} from "../../slack/blocks";
import type { SlackFile } from "../../slack/context";
import { runAgentForSlackOrg } from "./run-agent";
import type { SlackOrgCallbackContext } from "./run-agent";
import {
  resolveOrgFromWorkspace,
  resolveConnectionFromSlackUser,
  resolveDefaultComposeId,
  lookupThreadSession,
  enrichMessageContent,
  fetchConversationContexts,
  buildOrgConnectUrl,
  buildLogsUrl,
  buildAgentLogsUrl,
  getWorkspaceAgent,
  resolveSessionCompose,
} from "./shared";
import { getPlatformUrl } from "../../url";
import { logger } from "../../logger";

const log = logger("slack-org:mention");

interface OrgMentionContext {
  workspaceId: string;
  channelId: string;
  userId: string;
  messageText: string;
  messageTs: string;
  threadTs?: string;
  files?: SlackFile[];
}

/**
 * Handle an @mention event in an org-aware Slack workspace.
 */
export async function handleOrgMention(
  context: OrgMentionContext,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  // 1. Resolve workspace installation + org
  const resolved = await resolveOrgFromWorkspace(context.workspaceId);
  if (!resolved) {
    log.debug("Workspace not configured for org", {
      workspaceId: context.workspaceId,
    });
    return;
  }
  const { installation, orgId } = resolved;

  // Decrypt bot token
  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);
  const botUserId = installation.botUserId;
  const threadTs = context.threadTs ?? context.messageTs;

  // 2. Check if user is connected
  const connection = await resolveConnectionFromSlackUser(
    context.userId,
    context.workspaceId,
  );

  if (!connection) {
    // Post ephemeral login prompt
    const connectUrl = buildOrgConnectUrl(
      context.workspaceId,
      context.userId,
      context.channelId,
    );
    await client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId,
      thread_ts: threadTs,
      text: "Please connect your account first",
      blocks: buildLoginPromptMessage(connectUrl),
    });
    return;
  }

  // 3. Resolve default agent
  const composeId = await resolveDefaultComposeId(orgId);
  if (!composeId) {
    await client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId,
      thread_ts: threadTs,
      text: "No agent is configured for this org. Please ask your org admin to set a default agent.",
    });
    return;
  }

  const agent = await getWorkspaceAgent(composeId);
  if (!agent) {
    await client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId,
      thread_ts: threadTs,
      text: "The configured agent could not be found. Please contact your org admin.",
    });
    return;
  }
  const agentName = agent.name;

  // 4. Show thinking indicator
  await setThreadStatus(client, context.channelId, threadTs, "is thinking...");

  // 5. Enrich message content
  const messageContent = await enrichMessageContent({
    messageContent: context.messageText,
    files: context.files,
    botToken,
    channelId: context.channelId,
    threadTs,
    client,
    userId: context.userId,
  });

  // 6. Look up existing thread session
  let existingSessionId: string | undefined;
  let lastProcessedMessageTs: string | undefined;
  if (threadTs) {
    const session = await lookupThreadSession(
      context.channelId,
      threadTs,
      connection.id,
    );
    existingSessionId = session.existingSessionId;
    lastProcessedMessageTs = session.lastProcessedMessageTs;
  }

  // 6b. Validate session agent matches current default
  if (existingSessionId) {
    const sessionCompose = await resolveSessionCompose(
      existingSessionId,
      connection.vm0UserId,
    );
    if (sessionCompose && sessionCompose.composeId !== composeId) {
      log.debug("Agent changed, starting new session");
      existingSessionId = undefined;
      lastProcessedMessageTs = undefined;
    }
  }

  // 7. Fetch conversation context
  const { executionContext } = await fetchConversationContexts(
    client,
    context.channelId,
    context.threadTs,
    botUserId,
    botToken,
    lastProcessedMessageTs,
    context.messageTs,
  );

  // 8. Dispatch agent run with explicit orgId
  const callbackContext: SlackOrgCallbackContext = {
    workspaceId: context.workspaceId,
    channelId: context.channelId,
    threadTs,
    messageTs: context.messageTs,
    connectionId: connection.id,
    orgId,
    agentName,
    composeId,
    existingSessionId,
  };

  const { status, response, runId } = await runAgentForSlackOrg({
    composeId,
    agentName,
    sessionId: existingSessionId,
    prompt: messageContent,
    threadContext: executionContext,
    userId: connection.vm0UserId,
    orgId,
    callbackContext,
  });

  if (status === "queued") {
    await client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId,
      thread_ts: threadTs,
      text: "⚠ Run queued — concurrency limit reached. Will start automatically when a slot is available.",
    });
  } else if (status === "failed") {
    log.error("Failed to dispatch agent run", { response });
    const errorText = response ?? "Sorry, an error occurred. Please try again.";
    const logsUrl = runId
      ? buildLogsUrl(runId, agentName)
      : buildAgentLogsUrl(agentName);
    const deepLinks = detectDeepLinks(errorText, getPlatformUrl(), agentName);
    await client.chat.postMessage({
      channel: context.channelId,
      thread_ts: threadTs,
      text: errorText,
      blocks: buildAgentResponseMessage(
        errorText,
        agentName,
        logsUrl,
        deepLinks,
      ),
    });
    await setThreadStatus(client, context.channelId, threadTs, "").catch(
      (err) => log.warn("Failed to clear thread status", { error: err }),
    );
  }
}
