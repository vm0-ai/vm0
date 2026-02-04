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
 * 4. Get user's bindings
 * 5. If no bindings, prompt to add agent
 * 6. Route to agent (explicit or LLM)
 * 7. Find existing thread session (for session continuation)
 * 8. Fetch thread context
 * 9. Add thinking reaction
 * 10. Post thinking message
 * 11. Execute agent with session continuation
 * 12. Create thread session mapping (if new thread)
 * 13. Update thinking message with response
 * 14. Remove thinking reaction
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
        encryptedSecrets: slackBindings.encryptedSecrets,
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

    // Extract message content (remove bot mention)
    const messageContent = extractMessageContent(
      context.messageText,
      botUserId,
    );

    // 6. Route to agent
    const explicitSelection = parseExplicitAgentSelection(messageContent);
    let selectedAgentName: string | null = null;
    let promptText = messageContent;

    if (explicitSelection) {
      // Explicit agent selection: "use <agent> <message>"
      selectedAgentName = explicitSelection.agentName;
      promptText = explicitSelection.remainingMessage || messageContent;

      // Verify the agent exists
      const matchingBinding = bindings.find(
        (b) => b.agentName.toLowerCase() === selectedAgentName!.toLowerCase(),
      );
      if (!matchingBinding) {
        await postMessage(
          client,
          context.channelId,
          `Agent "${selectedAgentName}" not found. Available agents: ${bindings.map((b) => b.agentName).join(", ")}`,
          {
            threadTs,
            blocks: buildErrorMessage(`Agent "${selectedAgentName}" not found`),
          },
        );
        return;
      }
      selectedAgentName = matchingBinding.agentName;
    } else if (bindings.length === 1 && bindings[0]) {
      // Only one binding - use it directly
      selectedAgentName = bindings[0].agentName;
    } else {
      // Multiple bindings - use LLM router
      selectedAgentName = await routeToAgent(
        messageContent,
        bindings.map((b) => ({
          agentName: b.agentName,
          description: b.description,
        })),
      );

      if (!selectedAgentName) {
        // Couldn't determine which agent to use
        const agentList = bindings
          .map(
            (b) => `• \`${b.agentName}\`: ${b.description ?? "No description"}`,
          )
          .join("\n");
        await postMessage(
          client,
          context.channelId,
          `I couldn't determine which agent to use. Please specify: \`@VM0 use <agent> <message>\`\n\nAvailable agents:\n${agentList}`,
          { threadTs },
        );
        return;
      }
    }

    // Get the selected binding
    const selectedBinding = bindings.find(
      (b) => b.agentName === selectedAgentName,
    )!;

    // 7. Find existing thread session for this binding (if in a thread)
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

    // 8. Fetch Slack context (thread messages or recent channel messages)
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

    // 9. Add thinking reaction to user's message (non-critical, ignore errors)
    const reactionAdded = await client.reactions
      .add({
        channel: context.channelId,
        timestamp: context.messageTs,
        name: "hourglass_flowing_sand",
      })
      .then(() => true)
      .catch(() => false);

    // 10. Post thinking message (will be updated with response)
    const thinkingTs = await postMessage(
      client,
      context.channelId,
      "Thinking...",
      {
        threadTs,
        blocks: [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `:hourglass_flowing_sand: *Thinking...* (using \`${selectedAgentName}\`)`,
              },
            ],
          },
        ],
      },
    );

    try {
      // 11. Execute agent with session continuation (if in thread with same agent)
      const { response: agentResponse, sessionId: newSessionId } =
        await runAgentForSlack({
          binding: selectedBinding,
          sessionId: existingSessionId,
          prompt: promptText,
          threadContext: formattedContext,
          userId: userLink.vm0UserId,
          encryptionKey: SECRETS_ENCRYPTION_KEY,
        });

      // 12. Create thread session mapping if this is a new thread (no existing session)
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

      // 13. Update thinking message with actual response
      if (thinkingTs) {
        await client.chat.update({
          channel: context.channelId,
          ts: thinkingTs,
          text: agentResponse,
          blocks: buildMarkdownMessage(agentResponse),
        });
      } else {
        // Fallback: post new message if we don't have the thinking message ts
        await postMessage(client, context.channelId, agentResponse, {
          threadTs,
          blocks: buildMarkdownMessage(agentResponse),
        });
      }
    } finally {
      // 14. Remove thinking reaction (only if it was added)
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
    console.error("Error handling app_mention:", error);
    // Don't throw - we don't want to retry
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
