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
  saveThreadSession,
  resolveRunContext,
  buildLoginUrl,
  buildLogsUrl,
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

    const { composeId, bindingId, agentName, existingSessionId } = runCtx;

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

    try {
      // 6. Execute agent
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
        threadContext: "",
        userId: userLink.vm0UserId,
      });

      // 7. Create or update thread session mapping
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

      // 8. Post response message
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
      // 9. Remove thinking reaction
      if (reactionAdded) {
        await removeThinkingReaction(
          client,
          context.channelId,
          context.messageTs,
        );
      }
    }
  } catch (error) {
    log.error("Error handling direct_message", { error });
    // Don't throw - we don't want Slack to retry
  }
}
