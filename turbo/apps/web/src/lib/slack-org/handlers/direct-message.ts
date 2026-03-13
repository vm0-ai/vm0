import { decryptSecretValue } from "../../crypto/secrets-encryption";
import { env } from "../../../env";
import {
  createSlackClient,
  postMessage,
  setThreadStatus,
} from "../../slack/client";
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

const log = logger("slack-org:dm");

interface OrgDirectMessageContext {
  workspaceId: string;
  channelId: string;
  userId: string;
  messageText: string;
  messageTs: string;
  threadTs?: string;
  files?: SlackFile[];
}

/**
 * Handle a direct message event in an org-aware Slack workspace.
 *
 * Same as mention handler with DM-specific differences:
 * 1. No mention prefix stripping
 * 2. Login prompt uses postMessage (DMs are already private)
 */
export async function handleOrgDirectMessage(
  context: OrgDirectMessageContext,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  // 1. Resolve workspace + org
  const resolved = await resolveOrgFromWorkspace(context.workspaceId);
  if (!resolved) {
    return;
  }
  const { installation, orgId } = resolved;

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
    const connectUrl = buildOrgConnectUrl(
      context.workspaceId,
      context.userId,
      context.channelId,
    );
    await postMessage(
      client,
      context.channelId,
      "Please connect your account first",
      { blocks: buildLoginPromptMessage(connectUrl) },
    );
    return;
  }

  // 3. Resolve default agent
  const composeId = await resolveDefaultComposeId(orgId);
  if (!composeId) {
    await postMessage(
      client,
      context.channelId,
      "No agent is configured for this org. Please ask your org admin to set a default agent.",
      { threadTs },
    );
    return;
  }

  const agent = await getWorkspaceAgent(composeId);
  if (!agent) {
    await postMessage(
      client,
      context.channelId,
      "The configured agent could not be found. Please contact your org admin.",
      { threadTs },
    );
    return;
  }
  const agentName = agent.name;

  // 4. Show thinking indicator
  await setThreadStatus(client, context.channelId, threadTs, "is thinking...");

  // 5. Enrich message
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

  if (existingSessionId) {
    const sessionCompose = await resolveSessionCompose(
      existingSessionId,
      connection.vm0UserId,
    );
    if (sessionCompose && sessionCompose.composeId !== composeId) {
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

  // 8. Dispatch agent run
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
    const errorText = response ?? "Sorry, an error occurred. Please try again.";
    const logsUrl = runId
      ? buildLogsUrl(runId, agentName)
      : buildAgentLogsUrl(agentName);
    const deepLinks = detectDeepLinks(errorText, getPlatformUrl(), agentName);
    await postMessage(client, context.channelId, errorText, {
      threadTs,
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
