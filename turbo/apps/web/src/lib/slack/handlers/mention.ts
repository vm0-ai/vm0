import { eq, and } from "drizzle-orm";
import { slackInstallations } from "../../../db/schema/slack-installation";
import { slackUserLinks } from "../../../db/schema/slack-user-link";
import { decryptCredentialValue } from "../../crypto/secrets-encryption";
import { env } from "../../../env";
import { createSlackClient, postMessage } from "../client";
import { buildLoginPromptMessage } from "../blocks";
import { extractMessageContent } from "../context";
import { runAgentForSlack } from "./run-agent";
import {
  fetchConversationContexts,
  lookupThreadSession,
  buildLoginUrl,
  getWorkspaceAgent,
  resolveSessionCompose,
} from "./shared";
import { logger } from "../../logger";

const log = logger("slack:mention");

interface MentionContext {
  workspaceId: string;
  channelId: string;
  userId: string;
  messageText: string;
  messageTs: string;
  threadTs?: string;
}

/**
 * Handle an app_mention event from Slack
 *
 * Flow:
 * 1. Get workspace installation (includes defaultComposeId)
 * 2. Check if user is linked
 * 3. If not linked, post link message
 * 4. Resolve workspace agent name
 * 5. Add thinking reaction
 * 6. Look up existing thread session
 * 7. Fetch conversation context
 * 8. Dispatch agent run with callback
 *
 * Note: Response posting is now handled by the callback endpoint
 * when the agent run completes.
 */
export async function handleAppMention(context: MentionContext): Promise<void> {
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

  // Thread timestamp for replies (use existing thread or start new one)
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
    // 3. User not connected - post ephemeral connect message (only visible to user)
    const loginUrl = buildLoginUrl(
      context.workspaceId,
      context.userId,
      context.channelId,
    );
    await client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId,
      text: "Please connect your account first",
      blocks: buildLoginPromptMessage(loginUrl),
    });
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

  // 5. Add thinking reaction (emoji only, no message)
  const reactionAdded = await client.reactions
    .add({
      channel: context.channelId,
      timestamp: context.messageTs,
      name: "thought_balloon",
    })
    .then(() => true)
    .catch(() => false);

  // Extract message content (remove bot mention)
  const messageContent = extractMessageContent(context.messageText, botUserId);

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
