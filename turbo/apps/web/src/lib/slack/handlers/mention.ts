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
  extractMessageContent,
  fetchThreadContext,
  fetchChannelContext,
  formatContextForAgent,
  parseExplicitAgentSelection,
  buildLoginPromptMessage,
  buildErrorMessage,
  buildMarkdownMessage,
  getSlackRedirectBaseUrl,
} from "../index";
import { routeToAgent } from "../router";
import { runAgentForSlack } from "./run-agent";
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

interface AgentBinding {
  id: string;
  agentName: string;
  description: string | null;
  composeId: string;
  enabled: boolean;
}

type RouteSuccess = { success: true; agentName: string; promptText: string };
type RouteFailure = { success: false; error: string };

/**
 * Route message to the appropriate agent
 * Returns success with agent details or failure with error message
 */
async function routeMessageToAgent(
  messageContent: string,
  bindings: AgentBinding[],
): Promise<RouteSuccess | RouteFailure> {
  const explicitSelection = parseExplicitAgentSelection(messageContent);

  if (explicitSelection) {
    // Explicit agent selection: "use <agent> <message>"
    const matchingBinding = bindings.find(
      (b) =>
        b.agentName.toLowerCase() === explicitSelection.agentName.toLowerCase(),
    );
    if (!matchingBinding) {
      return {
        success: false,
        error: `Agent "${explicitSelection.agentName}" not found. Available agents: ${bindings.map((b) => b.agentName).join(", ")}`,
      };
    }
    return {
      success: true,
      agentName: matchingBinding.agentName,
      promptText: explicitSelection.remainingMessage || messageContent,
    };
  }

  if (bindings.length === 1 && bindings[0]) {
    // Only one binding - use it directly
    return {
      success: true,
      agentName: bindings[0].agentName,
      promptText: messageContent,
    };
  }

  // Multiple bindings - use LLM router
  const selectedAgentName = await routeToAgent(
    messageContent,
    bindings.map((b) => ({
      agentName: b.agentName,
      description: b.description,
    })),
  );

  if (!selectedAgentName) {
    const agentList = bindings
      .map((b) => `• \`${b.agentName}\`: ${b.description ?? "No description"}`)
      .join("\n");
    return {
      success: false,
      error: `I couldn't determine which agent to use. Please specify: \`@VM0 use <agent> <message>\`\n\nAvailable agents:\n${agentList}`,
    };
  }

  return {
    success: true,
    agentName: selectedAgentName,
    promptText: messageContent,
  };
}

/**
 * Handle an app_mention event from Slack
 *
 * Flow:
 * 1. Get workspace installation and decrypt bot token
 * 2. Check if user is linked
 * 3. If not linked, post link message
 * 4. Get user's bindings
 * 5. If no bindings, prompt to add agent
 * 6. Add thinking reaction (emoji only)
 * 7. Route to agent (explicit or LLM)
 * 8. Find existing thread session (for session continuation)
 * 9. Fetch thread context
 * 10. Execute agent with session continuation
 * 11. Create thread session mapping (if new thread)
 * 12. Post response message
 * 13. Remove thinking reaction
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
      // 3. User not logged in - post login message
      const loginUrl = buildLoginUrl(context.workspaceId, context.userId);
      await postMessage(client, context.channelId, "Please login first", {
        threadTs,
        blocks: buildLoginPromptMessage(loginUrl),
      });
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
      // 5. No bindings - prompt to add agent
      await postMessage(
        client,
        context.channelId,
        "You don't have any agents configured. Use `/vm0 agent add` to add one.",
        { threadTs },
      );
      return;
    }

    // 6. Add thinking reaction (emoji only, no message)
    const reactionAdded = await client.reactions
      .add({
        channel: context.channelId,
        timestamp: context.messageTs,
        name: "hourglass_flowing_sand",
      })
      .then(() => true)
      .catch(() => false);

    // Extract message content (remove bot mention)
    const messageContent = extractMessageContent(
      context.messageText,
      botUserId,
    );

    // 7. Route to agent
    const routeResult = await routeMessageToAgent(messageContent, bindings);

    if (!routeResult.success) {
      // Post error message and cleanup reaction
      await postMessage(client, context.channelId, routeResult.error, {
        threadTs,
        blocks: buildErrorMessage(routeResult.error),
      });
      if (reactionAdded) {
        await client.reactions
          .remove({
            channel: context.channelId,
            timestamp: context.messageTs,
            name: "hourglass_flowing_sand",
          })
          .catch(() => {});
      }
      return;
    }

    const { agentName: selectedAgentName, promptText } = routeResult;

    // Get the selected binding (guaranteed to exist since routeResult.success is true)
    const selectedBinding = bindings.find(
      (b) => b.agentName === selectedAgentName,
    );
    if (!selectedBinding) {
      // This should never happen since routeMessageToAgent only returns success
      // with an agent name that exists in bindings
      log.error("Selected binding not found after successful route", {
        selectedAgentName,
        availableBindings: bindings.map((b) => b.agentName),
      });
      return;
    }

    // 8. Find existing thread session for this binding (if in a thread)
    let existingSessionId: string | undefined;
    log.debug("Looking for thread session", {
      threadTs,
      contextThreadTs: context.threadTs,
      bindingId: selectedBinding.id,
      channelId: context.channelId,
    });
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
      log.debug("Thread session query result", { existingSessionId });
    }

    // 9. Fetch Slack context (thread messages or recent channel messages)
    let formattedContext = "";
    if (context.threadTs) {
      // In a thread - fetch thread replies
      const messages = await fetchThreadContext(
        client,
        context.channelId,
        context.threadTs,
      );
      formattedContext = formatContextForAgent(messages, botUserId, "thread");
    } else {
      // Not in a thread - fetch recent channel messages
      const messages = await fetchChannelContext(client, context.channelId, 10);
      formattedContext = formatContextForAgent(messages, botUserId, "channel");
    }

    try {
      // 10. Execute agent with session continuation
      log.debug("Calling runAgentForSlack", { existingSessionId });
      const { response: agentResponse, sessionId: newSessionId } =
        await runAgentForSlack({
          binding: selectedBinding,
          sessionId: existingSessionId,
          prompt: promptText,
          threadContext: formattedContext,
          userId: userLink.vm0UserId,
        });
      log.debug("runAgentForSlack returned", { newSessionId });

      // 11. Create thread session mapping if this is a new thread (no existing session)
      if (threadTs && !existingSessionId && newSessionId) {
        log.debug("Creating thread session mapping", {
          threadTs,
          newSessionId,
        });
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

      // 12. Post response message
      await postMessage(client, context.channelId, agentResponse, {
        threadTs,
        blocks: buildMarkdownMessage(agentResponse),
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
      // 13. Remove thinking reaction
      if (reactionAdded) {
        await client.reactions
          .remove({
            channel: context.channelId,
            timestamp: context.messageTs,
            name: "hourglass_flowing_sand",
          })
          .catch(() => {
            // Ignore errors when removing reaction
          });
      }
    }
  } catch (error) {
    log.error("Error handling app_mention", { error });
    // Don't throw - we don't want Slack to retry
  }
}

/**
 * Build the login URL
 */
function buildLoginUrl(workspaceId: string, slackUserId: string): string {
  const baseUrl = getSlackRedirectBaseUrl();
  const params = new URLSearchParams({
    w: workspaceId,
    u: slackUserId,
  });
  return `${baseUrl}/slack/link?${params.toString()}`;
}
