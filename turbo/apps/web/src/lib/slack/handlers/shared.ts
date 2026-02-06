import {
  createSlackClient,
  fetchThreadContext,
  fetchChannelContext,
  formatContextForAgentWithImages,
  parseExplicitAgentSelection,
  getSlackRedirectBaseUrl,
} from "../index";
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
 * Fetch conversation context for the agent with uploaded images
 * Images are uploaded to R2 and presigned URLs are provided in the context
 */
export async function fetchConversationContext(
  client: SlackClient,
  channelId: string,
  threadTs: string | undefined,
  botUserId: string,
  botToken: string,
): Promise<string> {
  // Use channel-thread as session ID for organizing uploaded images
  const imageSessionId = `${channelId}-${threadTs ?? "channel"}`;

  if (threadTs) {
    const messages = await fetchThreadContext(client, channelId, threadTs);
    return formatContextForAgentWithImages(
      messages,
      botToken,
      imageSessionId,
      botUserId,
      "thread",
    );
  }
  const messages = await fetchChannelContext(client, channelId, 10);
  return formatContextForAgentWithImages(
    messages,
    botToken,
    imageSessionId,
    botUserId,
    "channel",
  );
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
