import { WebClient, type WebAPICallResult } from "@slack/web-api";
import type { Block, KnownBlock, View } from "@slack/web-api";

/**
 * Check if an error is a Slack invalid_auth error
 * This happens when the bot token is revoked, expired, or invalid
 */
export function isSlackInvalidAuthError(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "slack_webapi_platform_error" &&
    "data" in error
  ) {
    const data = error.data as WebAPICallResult;
    return data.error === "invalid_auth";
  }
  return false;
}

/**
 * Create a Slack Web API client
 *
 * @param token - Bot token or user token
 * @returns WebClient instance
 */
export function createSlackClient(token: string): WebClient {
  return new WebClient(token);
}

/**
 * Post a message to a Slack channel or thread
 *
 * @param client - Slack WebClient
 * @param channel - Channel ID
 * @param text - Message text (used as fallback for blocks)
 * @param options - Additional options
 */
export async function postMessage(
  client: WebClient,
  channel: string,
  text: string,
  options?: {
    threadTs?: string;
    blocks?: (Block | KnownBlock)[];
  },
): Promise<string | undefined> {
  const result = await client.chat.postMessage({
    channel,
    text,
    thread_ts: options?.threadTs,
    blocks: options?.blocks,
  });

  return result.ts;
}

/**
 * Publish an App Home tab view for a user
 *
 * @param client - Slack WebClient
 * @param userId - Slack user ID
 * @param view - Home tab view definition
 */
export async function publishAppHome(
  client: WebClient,
  userId: string,
  view: View,
): Promise<void> {
  await client.views.publish({
    user_id: userId,
    view,
  });
}

/**
 * Open a modal in Slack
 *
 * @param client - Slack WebClient
 * @param triggerId - Trigger ID from slash command or interaction
 * @param view - Modal view definition
 */
export async function openModal(
  client: WebClient,
  triggerId: string,
  view: View,
): Promise<string | undefined> {
  const result = await client.views.open({
    trigger_id: triggerId,
    view,
  });

  return result.view?.id;
}

/**
 * Update an existing modal
 *
 * @param client - Slack WebClient
 * @param viewId - View ID to update
 * @param view - New view definition
 */
export async function updateModal(
  client: WebClient,
  viewId: string,
  view: View,
): Promise<void> {
  await client.views.update({
    view_id: viewId,
    view,
  });
}

/**
 * Exchange OAuth code for access token
 *
 * @param clientId - Slack app client ID
 * @param clientSecret - Slack app client secret
 * @param code - OAuth code from callback
 * @param redirectUri - OAuth redirect URI
 * @returns OAuth response with tokens and team info
 */
export async function exchangeOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<{
  accessToken: string;
  botUserId: string;
  teamId: string;
  teamName: string;
}> {
  const client = new WebClient();
  const result = await client.oauth.v2.access({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  if (
    !result.ok ||
    !result.access_token ||
    !result.bot_user_id ||
    !result.team
  ) {
    throw new Error(
      `OAuth exchange failed: ${result.error ?? "unknown error"}`,
    );
  }

  return {
    accessToken: result.access_token,
    botUserId: result.bot_user_id,
    teamId: result.team.id ?? "",
    teamName: result.team.name ?? "",
  };
}
