import { eq, and } from "drizzle-orm";
import { slackInstallations } from "../../../db/schema/slack-installation";
import { slackUserLinks } from "../../../db/schema/slack-user-link";
import { decryptCredentialValue } from "../../crypto/secrets-encryption";
import { env } from "../../../env";
import {
  createSlackClient,
  postMessage,
  extractMessageContent,
  buildLoginPromptMessage,
  buildAgentResponseMessage,
} from "../index";
import { runAgentForSlack } from "./run-agent";
import {
  removeThinkingReaction,
  fetchConversationContexts,
  saveThreadSession,
  resolveRunContext,
  buildLoginUrl,
  buildLogsUrl,
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
 * 1. Get workspace installation and decrypt bot token
 * 2. Check if user is linked
 * 3. If not linked, post link message
 * 4. Resolve which agent to run (thread session first, then binding fallback)
 * 5. Add thinking reaction
 * 6. Fetch conversation context
 * 7. Execute agent
 * 8. Create/update thread session mapping
 * 9. Post response message
 * 10. Remove thinking reaction
 */
export async function handleAppMention(context: MentionContext): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  try {
    // 1. Get workspace installation
    const [installation] = await globalThis.services.db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.slackWorkspaceId, context.workspaceId))
      .limit(1);

    if (!installation) {
      console.error(
        `Slack installation not found for workspace: ${context.workspaceId}`,
      );
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

    // 4. Resolve which agent to run (thread session first, then binding fallback)
    const runCtx = await resolveRunContext(
      context.channelId,
      threadTs,
      userLink.id,
    );

    if (!runCtx) {
      await postMessage(
        client,
        context.channelId,
        "You don't have any agent linked. Use `/vm0 agent link` to link one.",
        { threadTs },
      );
      return;
    }

    const {
      composeId,
      bindingId,
      agentName,
      existingSessionId,
      lastProcessedMessageTs,
    } = runCtx;

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
    const messageContent = extractMessageContent(
      context.messageText,
      botUserId,
    );

    // 6. Fetch context: execution gets deduplicated with images
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
      // 7. Execute agent with deduplicated context
      log.debug("Calling runAgentForSlack", { existingSessionId });
      const {
        status: runStatus,
        response: agentResponse,
        sessionId: newSessionId,
        runId,
      } = await runAgentForSlack({
        composeId,
        bindingId,
        sessionId: existingSessionId,
        prompt: messageContent,
        threadContext: executionContext,
        userId: userLink.vm0UserId,
      });

      // 8. Create or update thread session mapping
      if (threadTs) {
        await saveThreadSession({
          bindingId,
          channelId: context.channelId,
          threadTs,
          existingSessionId,
          newSessionId,
          messageTs: context.messageTs,
          runStatus,
        });
      }

      // 9. Post response message with agent name and logs link
      const logsUrl = runId ? buildLogsUrl(runId) : undefined;
      const responseText =
        runStatus === "timeout"
          ? `:warning: *Agent timed out*\n${agentResponse}`
          : agentResponse;
      await postMessage(client, context.channelId, responseText, {
        threadTs,
        blocks: buildAgentResponseMessage(responseText, agentName, logsUrl),
      });
    } catch (innerError) {
      // If postMessage or session creation fails, still try to notify the user
      log.error("Error posting response or creating session", {
        error: innerError,
      });
      await postMessage(
        client,
        context.channelId,
        "Sorry, an error occurred while sending the response. Please try again.",
        { threadTs },
      ).catch(() => {
        // If even the error message fails, we can't do anything more
      });
    } finally {
      // 10. Remove thinking reaction
      if (reactionAdded) {
        await removeThinkingReaction(
          client,
          context.channelId,
          context.messageTs,
        );
      }
    }
  } catch (error) {
    log.error("Error handling app_mention", { error });
    // Don't throw - we don't want Slack to retry
  }
}
