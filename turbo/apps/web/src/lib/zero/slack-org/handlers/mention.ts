import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { loadFeatureSwitchOverrides } from "../../user/feature-switches-service";
import { decryptSecretValue } from "../../../shared/crypto/secrets-encryption";
import { env } from "../../../../env";
import { createSlackClient, setThreadStatus } from "../../slack/client";
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

const log = logger("slack-org:mention");

interface OrgMentionContext {
  workspaceId: string;
  channelId: string;
  channelType?: string;
  userId: string;
  messageText: string;
  messageTs: string;
  threadTs?: string;
  files?: SlackFile[];
  apiStartTime: number;
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
    // Post ephemeral login prompt (no thread_ts so it's visible in the channel)
    const connectUrl = buildOrgConnectUrl(
      context.workspaceId,
      context.userId,
      context.channelId,
    );
    await client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId,
      text: "Please connect your account first",
      blocks: buildLoginPromptMessage(connectUrl),
    });
    return;
  }

  // 3. Resolve effective agent (user override or org default)
  const composeId = await resolveEffectiveComposeId(
    connection.vm0UserId,
    orgId,
  );
  if (!composeId) {
    await client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId,
      ...(context.threadTs && { thread_ts: threadTs }),
      text: "No agent is configured for this org. Please ask your org admin to set a default agent.",
    });
    return;
  }

  const agent = await getWorkspaceAgent(composeId);
  if (!agent) {
    await client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId,
      ...(context.threadTs && { thread_ts: threadTs }),
      text: "The configured agent could not be found. Please contact your org admin.",
    });
    return;
  }
  const agentName = agent.name;

  // 4. Show thinking indicator
  await setThreadStatus(client, context.channelId, threadTs, "is thinking...");

  // 5. Enrich message content
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

  // 6b. Validate session agent matches current default
  if (existingSessionId) {
    const sessionCompose = await resolveSessionCompose(
      existingSessionId,
      connection.vm0UserId,
    );
    if (sessionCompose && sessionCompose.composeId !== composeId) {
      log.debug("Agent changed, starting new session");
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
    orgId,
    sessionId: existingSessionId,
    prompt: messageContent,
    threadContext: executionContext,
    userInfoExtras,
    userId: connection.vm0UserId,
    modelProviderId: agent.modelProviderId,
    selectedModel: agent.selectedModel,
    botUserId,
    channelId: context.channelId,
    channelType:
      context.channelType === "im"
        ? "dm"
        : context.channelType === "mpim"
          ? "group_dm"
          : "channel",
    threadTs,
    callbackContext,
    apiStartTime: context.apiStartTime,
  });

  if (status === "queued") {
    const queueUrl = `${getAppUrl()}/?queue=1`;
    await client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId,
      ...(context.threadTs && { thread_ts: threadTs }),
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
      await postPreDispatchErrorReply({
        client,
        channelId: context.channelId,
        threadTs,
        errorText: response ?? "Sorry, an error occurred. Please try again.",
        orgId,
        vm0UserId: connection.vm0UserId,
        composeId,
        agentLabel: agent.displayName ?? agentName,
      });
    }

    await setThreadStatus(client, context.channelId, threadTs, "").catch(
      (err) => {
        return log.warn("Failed to clear thread status", { error: err });
      },
    );
  }
}

async function postPreDispatchErrorReply(opts: {
  client: ReturnType<typeof createSlackClient>;
  channelId: string;
  threadTs: string;
  errorText: string;
  orgId: string;
  vm0UserId: string;
  composeId: string;
  agentLabel: string;
}): Promise<void> {
  const overrides = await loadFeatureSwitchOverrides(
    opts.orgId,
    opts.vm0UserId,
  );
  const logsUrl = isFeatureEnabled(FeatureSwitchKey.AuditLink, {
    userId: opts.vm0UserId,
    orgId: opts.orgId,
    overrides,
  })
    ? buildAgentLogsUrl()
    : undefined;
  const orgDefaultComposeId = await resolveDefaultComposeId(opts.orgId);
  const triggeredBy =
    opts.composeId !== orgDefaultComposeId
      ? `Sent via ${opts.agentLabel}`
      : undefined;
  await opts.client.chat.postMessage({
    channel: opts.channelId,
    thread_ts: opts.threadTs,
    text: opts.errorText,
    blocks: buildAgentResponseMessage(opts.errorText, logsUrl, triggeredBy),
  });
}
