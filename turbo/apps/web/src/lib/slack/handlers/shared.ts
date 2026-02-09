import { eq, and } from "drizzle-orm";
import {
  createSlackClient,
  fetchThreadContext,
  fetchChannelContext,
  formatContextForAgent,
  formatContextForAgentWithImages,
  parseExplicitAgentSelection,
  getSlackRedirectBaseUrl,
} from "../index";
import { slackThreadSessions } from "../../../db/schema/slack-thread-session";
import { routeToAgent, type RouteResult } from "../router";
import { getPlatformUrl } from "../../url";

export type SlackClient = ReturnType<typeof createSlackClient>;

export interface AgentBinding {
  id: string;
  agentName: string;
  description: string | null;
  composeId: string;
  enabled: boolean;
}

export type RouteSuccess = {
  type: "success";
  agentName: string;
  promptText: string;
};
export type RouteFailure = { type: "failure"; error: string };
export type RouteNotRequest = { type: "not_request" };
export type RouteMessageResult = RouteSuccess | RouteFailure | RouteNotRequest;

/**
 * Remove the thinking reaction from a message
 */
export async function removeThinkingReaction(
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
 * Fetch conversation context with deduplication support.
 * Returns separate contexts for routing (text-only, full history) and
 * execution (with images, only new messages since lastProcessedMessageTs).
 *
 * Single Slack API call — messages are fetched once and filtered in-memory.
 */
export async function fetchConversationContexts(
  client: SlackClient,
  channelId: string,
  threadTs: string | undefined,
  botUserId: string,
  botToken: string,
  lastProcessedMessageTs?: string,
  currentMessageTs?: string,
): Promise<{ routingContext: string; executionContext: string }> {
  const imageSessionId = `${channelId}-${threadTs ?? "channel"}`;
  const contextType = threadTs ? "thread" : "channel";

  // Fetch all messages once (single Slack API call)
  const allMessages = threadTs
    ? await fetchThreadContext(client, channelId, threadTs)
    : await fetchChannelContext(client, channelId, 10);

  // Exclude the current message (it's already sent as the prompt)
  const contextMessages = currentMessageTs
    ? allMessages.filter((m) => m.ts !== currentMessageTs)
    : allMessages;

  // Text-only full context for routing (no image uploads needed)
  const routingContext = formatContextForAgent(
    contextMessages,
    botUserId,
    contextType,
  );

  // Filter to only new messages for execution context
  const executionMessages = lastProcessedMessageTs
    ? contextMessages.filter((m) => !m.ts || m.ts > lastProcessedMessageTs)
    : contextMessages;

  // Format execution context with images (only uploads images for new messages)
  const executionContext =
    executionMessages.length > 0
      ? await formatContextForAgentWithImages(
          executionMessages,
          botToken,
          imageSessionId,
          botUserId,
          contextType,
        )
      : "";

  return { routingContext, executionContext };
}

/**
 * Route message to the appropriate agent
 * Returns success with agent details, failure with error message, or not_request for greetings
 */
export async function routeMessageToAgent(
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

interface ThreadSessionLookup {
  existingSessionId: string | undefined;
  lastProcessedMessageTs: string | undefined;
}

/**
 * Look up an existing thread session by channel + thread.
 * Optionally refines with bindingId if provided.
 */
export async function lookupThreadSession(
  channelId: string,
  threadTs: string,
  bindingId?: string,
): Promise<ThreadSessionLookup> {
  const conditions = bindingId
    ? [
        eq(slackThreadSessions.slackBindingId, bindingId),
        eq(slackThreadSessions.slackChannelId, channelId),
        eq(slackThreadSessions.slackThreadTs, threadTs),
      ]
    : [
        eq(slackThreadSessions.slackChannelId, channelId),
        eq(slackThreadSessions.slackThreadTs, threadTs),
      ];

  const [session] = await globalThis.services.db
    .select({
      agentSessionId: slackThreadSessions.agentSessionId,
      lastProcessedMessageTs: slackThreadSessions.lastProcessedMessageTs,
    })
    .from(slackThreadSessions)
    .where(and(...conditions))
    .limit(1);

  return {
    existingSessionId: session?.agentSessionId,
    lastProcessedMessageTs: session?.lastProcessedMessageTs ?? undefined,
  };
}

/**
 * Create or update a thread session mapping after agent execution.
 */
export async function saveThreadSession(opts: {
  bindingId: string;
  channelId: string;
  threadTs: string;
  existingSessionId: string | undefined;
  newSessionId: string | undefined;
  messageTs: string;
  runStatus: string;
}): Promise<void> {
  const {
    bindingId,
    channelId,
    threadTs,
    existingSessionId,
    newSessionId,
    messageTs,
    runStatus,
  } = opts;

  if (!existingSessionId && newSessionId) {
    // New thread — create mapping
    await globalThis.services.db
      .insert(slackThreadSessions)
      .values({
        slackBindingId: bindingId,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        agentSessionId: newSessionId,
        lastProcessedMessageTs: messageTs,
      })
      .onConflictDoNothing();
  } else if (
    existingSessionId &&
    (runStatus === "completed" || runStatus === "timeout")
  ) {
    // Existing thread, successful run — update lastProcessedMessageTs
    await globalThis.services.db
      .update(slackThreadSessions)
      .set({
        lastProcessedMessageTs: messageTs,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(slackThreadSessions.slackBindingId, bindingId),
          eq(slackThreadSessions.slackChannelId, channelId),
          eq(slackThreadSessions.slackThreadTs, threadTs),
        ),
      );
  }
  // Failed runs — do not update lastProcessedMessageTs (allows retry with same context)
}

/**
 * Build the login URL
 */
export function buildLoginUrl(
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
export function buildLogsUrl(runId: string): string {
  return `${getPlatformUrl()}/logs/${runId}`;
}
