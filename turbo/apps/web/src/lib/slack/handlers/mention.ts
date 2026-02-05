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
  buildAgentResponseMessage,
  buildWelcomeMessage,
  getSlackRedirectBaseUrl,
} from "../index";
import { routeToAgent, type RouteResult } from "../router";
import { runAgentForSlack } from "./run-agent";
import { logger } from "../../logger";
import { getPlatformUrl } from "../../url";

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

type RouteSuccess = { type: "success"; agentName: string; promptText: string };
type RouteFailure = { type: "failure"; error: string };
type RouteNotRequest = { type: "not_request" };
type RouteMessageResult = RouteSuccess | RouteFailure | RouteNotRequest;

type SlackClient = ReturnType<typeof createSlackClient>;

/**
 * Remove the thinking reaction from a message
 */
async function removeThinkingReaction(
  client: SlackClient,
  channelId: string,
  messageTs: string,
): Promise<void> {
  await client.reactions
    .remove({
      channel: channelId,
      timestamp: messageTs,
      name: "thought_balloon",
    })
    .catch(() => {
      // Ignore errors when removing reaction
    });
}

/**
 * Fetch conversation context for the agent
 */
async function fetchConversationContext(
  client: SlackClient,
  channelId: string,
  threadTs: string | undefined,
  botUserId: string,
): Promise<string> {
  if (threadTs) {
    const messages = await fetchThreadContext(client, channelId, threadTs);
    return formatContextForAgent(messages, botUserId, "thread");
  }
  const messages = await fetchChannelContext(client, channelId, 10);
  return formatContextForAgent(messages, botUserId, "channel");
}

/**
 * Route message to the appropriate agent
 * Returns success with agent details, failure with error message, or not_request for greetings
 */
async function routeMessageToAgent(
  messageContent: string,
  bindings: AgentBinding[],
  context?: string,
): Promise<RouteMessageResult> {
  const explicitSelection = parseExplicitAgentSelection(messageContent);

  if (explicitSelection) {
    // Explicit agent selection: "use <agent> <message>"
    const matchingBinding = bindings.find(
      (b) =>
        b.agentName.toLowerCase() === explicitSelection.agentName.toLowerCase(),
    );
    if (!matchingBinding) {
      return {
        type: "failure",
        error: `Agent "${explicitSelection.agentName}" not found. Available agents: ${bindings.map((b) => b.agentName).join(", ")}`,
      };
    }
    return {
      type: "success",
      agentName: matchingBinding.agentName,
      promptText: explicitSelection.remainingMessage || messageContent,
    };
  }

  // Use the router (handles single agent, keyword matching, and LLM routing)
  const routeResult: RouteResult = await routeToAgent(
    messageContent,
    bindings.map((b) => ({
      agentName: b.agentName,
      description: b.description,
    })),
    context,
  );

  switch (routeResult.type) {
    case "matched":
      return {
        type: "success",
        agentName: routeResult.agentName,
        promptText: messageContent,
      };
    case "not_request":
      return { type: "not_request" };
    case "ambiguous": {
      const agentList = bindings
        .map(
          (b) => `• \`${b.agentName}\`: ${b.description ?? "No description"}`,
        )
        .join("\n");
      return {
        type: "failure",
        error: `I couldn't determine which agent to use. Please specify: \`@VM0 use <agent> <message>\`\n\nAvailable agents:\n${agentList}`,
      };
    }
  }
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
      // 3. User not logged in - post ephemeral login message (only visible to user)
      const loginUrl = buildLoginUrl(
        context.workspaceId,
        context.userId,
        context.channelId,
      );
      // Note: Don't include thread_ts for ephemeral messages - they don't appear correctly in threads
      await client.chat.postEphemeral({
        channel: context.channelId,
        user: context.userId,
        text: "Please login first",
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
      // 5. No bindings - prompt to link agent
      await postMessage(
        client,
        context.channelId,
        "You don't have any agent linked. Use `/vm0 agent link` to link one.",
        { threadTs },
      );
      return;
    }

    // 6. Add thinking reaction (emoji only, no message)
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

    // Fetch Slack context early (needed for routing and agent execution)
    const formattedContext = await fetchConversationContext(
      client,
      context.channelId,
      context.threadTs,
      botUserId,
    );

    // 7. Route to agent (with context for LLM routing)
    const routeResult = await routeMessageToAgent(
      messageContent,
      bindings,
      formattedContext,
    );

    if (routeResult.type === "not_request") {
      // User is not requesting agent assistance (greeting, casual chat)
      await postMessage(client, context.channelId, "Welcome to VM0!", {
        threadTs,
        blocks: buildWelcomeMessage(bindings),
      });
      if (reactionAdded) {
        await removeThinkingReaction(
          client,
          context.channelId,
          context.messageTs,
        );
      }
      return;
    }

    if (routeResult.type === "failure") {
      // Post error message
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

    // Context already fetched earlier for routing

    try {
      // 10. Execute agent with session continuation
      log.debug("Calling runAgentForSlack", { existingSessionId });
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
      log.debug("runAgentForSlack returned", { newSessionId, runId });

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

      // 12. Post response message with agent name and logs link
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

/**
 * Build the login URL
 */
function buildLoginUrl(
  workspaceId: string,
  slackUserId: string,
  channelId: string,
): string {
  const baseUrl = getSlackRedirectBaseUrl();
  const params = new URLSearchParams({
    w: workspaceId,
    u: slackUserId,
    c: channelId,
  });
  return `${baseUrl}/slack/link?${params.toString()}`;
}

/**
 * Build the logs URL for a run
 */
function buildLogsUrl(runId: string): string {
  return `${getPlatformUrl()}/logs/${runId}`;
}
