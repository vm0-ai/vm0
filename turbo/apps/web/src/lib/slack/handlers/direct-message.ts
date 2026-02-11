import { eq, and } from "drizzle-orm";
import { slackInstallations } from "../../../db/schema/slack-installation";
import { slackUserLinks } from "../../../db/schema/slack-user-link";
import { decryptCredentialValue } from "../../crypto/secrets-encryption";
import { env } from "../../../env";
import {
  createSlackClient,
  postMessage,
  buildLoginPromptMessage,
  buildAgentResponseMessage,
} from "../index";
import { runAgentForSlack } from "./run-agent";
import {
  removeThinkingReaction,
  fetchConversationContexts,
  lookupThreadSession,
  saveThreadSession,
  buildLoginUrl,
  buildLogsUrl,
  getWorkspaceAgent,
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

  // 4. Resolve workspace agent
  const agent = await getWorkspaceAgent(installation.defaultComposeId);
  if (!agent) {
    await postMessage(
      client,
      context.channelId,
      "The workspace agent is not available. Please contact the workspace admin.",
      { threadTs },
    );
    return;
  }

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

  try {
    // 8. Execute agent with deduplicated context
    const {
      status: runStatus,
      response: agentResponse,
      sessionId: newSessionId,
      runId,
    } = await runAgentForSlack({
      composeId: installation.defaultComposeId,
      agentName: agent.name,
      sessionId: existingSessionId,
      prompt: messageContent,
      threadContext: executionContext,
      userId: userLink.vm0UserId,
    });

    // 9. Create or update thread session mapping
    if (threadTs) {
      await saveThreadSession({
        userLinkId: userLink.id,
        channelId: context.channelId,
        threadTs,
        existingSessionId,
        newSessionId,
        messageTs: context.messageTs,
        runStatus,
      });
    }

    // 10. Post response message
    const logsUrl = runId ? buildLogsUrl(runId) : undefined;
    const responseText =
      runStatus === "timeout"
        ? `:warning: *Agent timed out*\n${agentResponse}`
        : agentResponse;
    await postMessage(client, context.channelId, responseText, {
      threadTs,
      blocks: buildAgentResponseMessage(responseText, agent.name, logsUrl),
    });
  } catch (innerError) {
    log.error("Error posting response or creating session", {
      error: innerError,
    });
    await postMessage(
      client,
      context.channelId,
      "Sorry, an error occurred while sending the response. Please try again.",
      { threadTs },
    ).catch((e) => log.warn("Failed to post error message", { error: e }));
  } finally {
    // 11. Remove thinking reaction
    if (reactionAdded) {
      await removeThinkingReaction(
        client,
        context.channelId,
        context.messageTs,
      );
    }
  }
}
