import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/api-contracts/feature-switch-key";
import { loadFeatureSwitchOverrides } from "../../user/feature-switches-service";
import { decryptSecretValue } from "../../../shared/crypto/secrets-encryption";
import { env } from "../../../../env";
import {
  createSlackClient,
  postMessage,
  setThreadStatus,
} from "../../slack/client";
import {
  buildAgentResponseMessage,
  buildLoginPromptMessage,
} from "../../slack/blocks";
import type { SlackFile } from "../../slack/context";
import { runAgentForSlackOrg } from "./run-agent";
import type { SlackOrgCallbackPayload } from "../../../infra/callback/callback-payloads";
import {
  resolveOrgFromWorkspace,
  resolveConnectionFromSlackUser,
  resolveDefaultComposeId,
  resolveEffectiveComposeId,
  lookupThreadSession,
  enrichMessageContent,
  fetchConversationContexts,
  buildOrgConnectUrl,
  buildAgentLogsUrl,
  getWorkspaceAgent,
  resolveSessionCompose,
} from "./shared";
import { getAppUrl } from "../../url";
import { logger } from "../../../shared/logger";

const log = logger("slack-org:dm");

interface OrgDirectMessageContext {
  workspaceId: string;
  channelId: string;
  userId: string;
  messageText: string;
  messageTs: string;
  threadTs?: string;
  files?: SlackFile[];
  apiStartTime: number;
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
      threadTs,
    );
    await postMessage(
      client,
      context.channelId,
      "Please connect your account first",
      { threadTs, blocks: buildLoginPromptMessage(connectUrl) },
    );
    return;
  }

  // 3. Resolve effective agent (user override or org default)
  const composeId = await resolveEffectiveComposeId(
    connection.vm0UserId,
    orgId,
  );
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
  const { prompt: messageContent, userInfoExtras } = await enrichMessageContent(
    {
      messageContent: context.messageText,
      files: context.files,
      client,
      userId: context.userId,
    },
  );

  // 6. Look up existing thread session
  let existingSessionId: string | undefined;
  if (threadTs) {
    const session = await lookupThreadSession(
      context.channelId,
      threadTs,
      connection.id,
    );
    existingSessionId = session.existingSessionId;
  }

  if (existingSessionId) {
    const sessionCompose = await resolveSessionCompose(
      existingSessionId,
      connection.vm0UserId,
    );
    if (sessionCompose && sessionCompose.composeId !== composeId) {
      existingSessionId = undefined;
    }
  }

  // 7. Fetch conversation context
  const { executionContext } = await fetchConversationContexts(
    client,
    context.channelId,
    context.threadTs,
    context.messageTs,
  );

  // 8. Dispatch agent run
  const callbackContext: SlackOrgCallbackPayload = {
    workspaceId: context.workspaceId,
    channelId: context.channelId,
    threadTs,
    messageTs: context.messageTs,
    connectionId: connection.id,
    agentId: composeId,
    existingSessionId,
  };

  const { status, response, runId } = await runAgentForSlackOrg({
    composeId,
    agentId: agent.agentId,
    agentName,
    sessionId: existingSessionId,
    prompt: messageContent,
    threadContext: executionContext,
    userInfoExtras,
    userId: connection.vm0UserId,
    botUserId,
    channelId: context.channelId,
    channelType: "dm",
    threadTs,
    callbackContext,
    apiStartTime: context.apiStartTime,
  });

  if (status === "queued") {
    const queueUrl = `${getAppUrl()}/?queue=1`;
    await client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId,
      thread_ts: threadTs,
      text: `⚠ Run queued — concurrency limit reached. Will start automatically when a slot is available. <${queueUrl}|View queue>`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:warning: *Run queued*\n\nConcurrency limit reached. Will start automatically when a slot is available.`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `<${queueUrl}|View queue>`,
            },
          ],
        },
      ],
    });
  } else if (status === "failed") {
    log.error("Failed to dispatch agent run", { response, runId });

    // When the run was created (runId exists), the completion callback
    // will post the error to Slack — skip here to avoid duplicate messages.
    if (!runId) {
      const errorText =
        response ?? "Sorry, an error occurred. Please try again.";
      const overrides = await loadFeatureSwitchOverrides(
        orgId,
        connection.vm0UserId,
      );
      const logsUrl = isFeatureEnabled(FeatureSwitchKey.AuditLink, {
        userId: connection.vm0UserId,
        orgId,
        overrides,
      })
        ? buildAgentLogsUrl()
        : undefined;
      const orgDefaultComposeId = await resolveDefaultComposeId(orgId);
      const triggeredBy =
        composeId !== orgDefaultComposeId
          ? `Sent via ${agent.displayName ?? agentName}`
          : undefined;
      await postMessage(client, context.channelId, errorText, {
        threadTs,
        blocks: buildAgentResponseMessage(errorText, logsUrl, triggeredBy),
      });
    }

    await setThreadStatus(client, context.channelId, threadTs, "").catch(
      (err) => {
        return log.warn("Failed to clear thread status", { error: err });
      },
    );
  }
}
