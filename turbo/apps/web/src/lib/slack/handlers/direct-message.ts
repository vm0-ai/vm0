import { eq, and } from "drizzle-orm";
import { slackInstallations } from "../../../db/schema/slack-installation";
import { slackUserLinks } from "../../../db/schema/slack-user-link";
import { slackBindings } from "../../../db/schema/slack-binding";
import { slackThreadSessions } from "../../../db/schema/slack-thread-session";
import { decryptCredentialValue } from "../../crypto/secrets-encryption";
import { env } from "../../../env";
import {
  createSlackClient,
  postMessage,
  buildLoginPromptMessage,
  buildErrorMessage,
  buildAgentResponseMessage,
} from "../index";
import { runAgentForSlack } from "./run-agent";
import {
  removeThinkingReaction,
  fetchConversationContext,
  routeMessageToAgent,
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
 * 3. not_request result routes to agent (user deliberately DM'd the bot)
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
    const botUserId = installation.botUserId;

    // In DMs, only use thread_ts when replying within an existing thread.
    // Top-level DM messages should get flat chat replies (no thread).
    const threadTs = context.threadTs;

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

    // 4. Get user's bindings
    const bindings = await globalThis.services.db
      .select({
        id: slackBindings.id,
        agentName: slackBindings.agentName,
        description: slackBindings.description,
        composeId: slackBindings.composeId,
        enabled: slackBindings.enabled,
      })
      .from(slackBindings)
      .where(
        and(
          eq(slackBindings.slackUserLinkId, userLink.id),
          eq(slackBindings.enabled, true),
        ),
      );

    if (bindings.length === 0) {
      // 5. No bindings - prompt to link agent
      await postMessage(
        client,
        context.channelId,
        "You don't have any agent linked. Use `/vm0 agent link` to link one.",
        { threadTs },
      );
      return;
    }

    // 6. Add thinking reaction
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

    // Fetch Slack context early (needed for routing and agent execution)
    const formattedContext = await fetchConversationContext(
      client,
      context.channelId,
      context.threadTs,
      botUserId,
      botToken,
    );

    // 7. Route to agent (with context for LLM routing)
    const routeResult = await routeMessageToAgent(
      messageContent,
      bindings,
      formattedContext,
    );

    // In DMs, not_request routes to the first/single agent (user deliberately DM'd the bot)
    let selectedAgentName: string;
    let promptText: string;

    if (routeResult.type === "not_request") {
      selectedAgentName = bindings[0]!.agentName;
      promptText = messageContent;
    } else if (routeResult.type === "failure") {
      await postMessage(client, context.channelId, routeResult.error, {
        threadTs,
        blocks: buildErrorMessage(routeResult.error),
      });
      if (reactionAdded) {
        await removeThinkingReaction(
          client,
          context.channelId,
          context.messageTs,
        );
      }
      return;
    } else {
      selectedAgentName = routeResult.agentName;
      promptText = routeResult.promptText;
    }

    // Get the selected binding
    const selectedBinding = bindings.find(
      (b) => b.agentName === selectedAgentName,
    );
    if (!selectedBinding) {
      log.error("Selected binding not found after successful route", {
        selectedAgentName,
        availableBindings: bindings.map((b) => b.agentName),
      });
      return;
    }

    // 8. Find existing thread session
    let existingSessionId: string | undefined;
    if (threadTs) {
      const [threadSession] = await globalThis.services.db
        .select({ agentSessionId: slackThreadSessions.agentSessionId })
        .from(slackThreadSessions)
        .where(
          and(
            eq(slackThreadSessions.slackBindingId, selectedBinding.id),
            eq(slackThreadSessions.slackChannelId, context.channelId),
            eq(slackThreadSessions.slackThreadTs, threadTs),
          ),
        )
        .limit(1);

      existingSessionId = threadSession?.agentSessionId;
    }

    try {
      // 9. Execute agent
      const {
        response: agentResponse,
        sessionId: newSessionId,
        runId,
      } = await runAgentForSlack({
        binding: selectedBinding,
        sessionId: existingSessionId,
        prompt: promptText,
        threadContext: formattedContext,
        userId: userLink.vm0UserId,
      });

      // 10. Create thread session mapping if new thread
      if (threadTs && !existingSessionId && newSessionId) {
        await globalThis.services.db
          .insert(slackThreadSessions)
          .values({
            slackBindingId: selectedBinding.id,
            slackChannelId: context.channelId,
            slackThreadTs: threadTs,
            agentSessionId: newSessionId,
          })
          .onConflictDoNothing();
      }

      // 11. Post response message
      const logsUrl = runId ? buildLogsUrl(runId) : undefined;
      await postMessage(client, context.channelId, agentResponse, {
        threadTs,
        blocks: buildAgentResponseMessage(
          agentResponse,
          selectedAgentName,
          logsUrl,
        ),
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
      ).catch(() => {
        // If even the error message fails, we can't do anything more
      });
    } finally {
      // 12. Remove thinking reaction
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
