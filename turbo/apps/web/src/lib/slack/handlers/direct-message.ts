import { eq, and } from "drizzle-orm";
import { slackInstallations } from "../../../db/schema/slack-installation";
import { slackUserLinks } from "../../../db/schema/slack-user-link";
import { decryptCredentialValue } from "../../crypto/secrets-encryption";
import { env } from "../../../env";
import { createSlackClient, postMessage } from "../client";
import { buildLoginPromptMessage } from "../blocks";
import { runAgentForSlack } from "./run-agent";
import {
  fetchConversationContexts,
  lookupThreadSession,
  buildLoginUrl,
  getWorkspaceAgent,
  resolveSessionCompose,
} from "./shared";
import { logger } from "../../logger";

const log = logger("slack:dm");

interface DirectMessageContext {
  workspaceId: string;
  channelId: string;
  userId: string;
  messageText: string;
  messageTs: string;
  threadTs?: string;
}

/**
 * Handle a direct message event from Slack
 *
 * Same flow as handleAppMention() with these differences:
 * 1. No mention prefix stripping — use messageText directly
 * 2. Login prompt uses postMessage instead of postEphemeral (DMs are already private)
 *
 * Note: Response posting is now handled by the callback endpoint
 * when the agent run completes.
 */
export async function handleDirectMessage(
  context: DirectMessageContext,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  // 1. Get workspace installation
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, context.workspaceId))
    .limit(1);

  if (!installation) {
    log.error("Slack installation not found for workspace", {
      workspaceId: context.workspaceId,
    });
    return;
  }

  // Decrypt bot token
  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);
  const botUserId = installation.botUserId;
  // Always reply in a thread so sessions persist across messages.
  const threadTs = context.threadTs ?? context.messageTs;

  // 2. Check if user is linked
  const [userLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, context.userId),
        eq(slackUserLinks.slackWorkspaceId, context.workspaceId),
      ),
    )
    .limit(1);

  if (!userLink) {
    // 3. User not connected - post direct message (not ephemeral, DMs are already private)
    const loginUrl = buildLoginUrl(
      context.workspaceId,
      context.userId,
      context.channelId,
    );
    await postMessage(
      client,
      context.channelId,
      "Please connect your account first",
      { blocks: buildLoginPromptMessage(loginUrl) },
    );
    return;
  }

  // 4. Resolve workspace agent (may be overridden by session below)
  let composeId = installation.defaultComposeId;
  const defaultAgent = await getWorkspaceAgent(composeId);
  if (!defaultAgent) {
    await postMessage(
      client,
      context.channelId,
      "The workspace agent is not available. Please contact the workspace admin.",
      { threadTs },
    );
    return;
  }
  let agentName = defaultAgent.name;

  // 5. Add thinking reaction
  const reactionAdded = await client.reactions
    .add({
      channel: context.channelId,
      timestamp: context.messageTs,
      name: "thought_balloon",
    })
    .then(() => true)
    .catch(() => false);

  // Use message text directly (no mention prefix to strip in DMs)
  const messageContent = context.messageText;

  // 6. Look up existing thread session for deduplication
  let existingSessionId: string | undefined;
  let lastProcessedMessageTs: string | undefined;
  if (threadTs) {
    const session = await lookupThreadSession(
      context.channelId,
      threadTs,
      userLink.id,
    );
    existingSessionId = session.existingSessionId;
    lastProcessedMessageTs = session.lastProcessedMessageTs;
    log.debug("Thread session lookup", {
      existingSessionId,
      lastProcessedMessageTs,
    });
  }

  // 6b. If continuing session, use session's compose instead of workspace default
  if (existingSessionId) {
    const sessionCompose = await resolveSessionCompose(
      existingSessionId,
      userLink.vm0UserId,
    );
    if (sessionCompose) {
      composeId = sessionCompose.composeId;
      agentName = sessionCompose.agentName;
      log.debug("Using session compose", { composeId, agentName });
    }
  }

  // 7. Fetch context: execution gets deduplicated with images
  const { executionContext } = await fetchConversationContexts(
    client,
    context.channelId,
    context.threadTs,
    botUserId,
    botToken,
    lastProcessedMessageTs,
    context.messageTs,
  );

  // 8. Dispatch agent run with callback (returns immediately)
  log.debug("Dispatching agent run", { existingSessionId });
  const { status, response } = await runAgentForSlack({
    composeId,
    agentName,
    sessionId: existingSessionId,
    prompt: messageContent,
    threadContext: executionContext,
    userId: userLink.vm0UserId,
    callbackContext: {
      workspaceId: context.workspaceId,
      channelId: context.channelId,
      threadTs,
      messageTs: context.messageTs,
      userLinkId: userLink.id,
      agentName,
      composeId,
      existingSessionId,
      reactionAdded,
    },
  });

  // Only handle immediate failures (agent run was not dispatched)
  if (status === "failed") {
    log.error("Failed to dispatch agent run", { response });
    await postMessage(
      client,
      context.channelId,
      response ?? "Sorry, an error occurred. Please try again.",
      { threadTs },
    );
    // Remove reaction on failure since callback won't be invoked
    if (reactionAdded) {
      await client.reactions
        .remove({
          channel: context.channelId,
          timestamp: context.messageTs,
          name: "thought_balloon",
        })
        .catch(() => {});
    }
  }
  // For "dispatched" status, callback will handle response posting and reaction removal
}
