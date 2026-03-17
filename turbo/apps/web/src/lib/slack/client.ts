import { WebClient } from "@slack/web-api";
import type { Block, KnownBlock, View } from "@slack/web-api";

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
): Promise<{ ts: string | undefined; channel: string | undefined }> {
  const result = await client.chat.postMessage({
    channel,
    text,
    thread_ts: options?.threadTs,
    blocks: options?.blocks,
  });

  return { ts: result.ts, channel: result.channel };
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
 * Fetch basic Slack user info (display name, real name, timezone)
 *
 * @param client - Slack WebClient
 * @param userId - Slack user ID
 * @returns User info string for prompt context, or undefined if lookup fails
 */
export async function fetchSlackUserInfo(
  client: WebClient,
  userId: string,
): Promise<string | undefined> {
  const result = await client.users.info({ user: userId });
  if (!result.ok || !result.user) return undefined;

  const u = result.user;
  const displayName =
    u.profile?.display_name || u.profile?.real_name || u.real_name || u.name;
  const tz = u.tz_label || u.tz;

  const parts: string[] = [];
  parts.push(`Slack User ID: ${userId}`);
  if (displayName) parts.push(`Name: ${displayName}`);
  if (tz) parts.push(`Timezone: ${tz}`);

  return parts.join("\n");
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
  authedUserId: string;
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
    authedUserId: result.authed_user?.id ?? "",
  };
}

/**
 * Exchange an OAuth code for user identity only (no bot token).
 * Used by the connect flow where the app is already installed and we only
 * need to identify which Slack user authorized.
 */
export async function exchangeOAuthCodeForUser(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<{
  teamId: string;
  authedUserId: string;
}> {
  const client = new WebClient();
  const result = await client.oauth.v2.access({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  if (!result.ok || !result.authed_user?.id || !result.team?.id) {
    throw new Error(
      `OAuth user exchange failed: ${result.error ?? "unknown error"}`,
    );
  }

  return {
    teamId: result.team.id,
    authedUserId: result.authed_user.id,
  };
}

/**
 * Update an existing message in a Slack channel
 *
 * @param client - Slack WebClient
 * @param channel - Channel ID
 * @param ts - Message timestamp to update
 * @param text - New text (fallback for blocks)
 * @param blocks - Optional Block Kit blocks
 */
export async function updateMessage(
  client: WebClient,
  channel: string,
  ts: string,
  text: string,
  blocks?: (Block | KnownBlock)[],
): Promise<void> {
  await client.chat.update({
    channel,
    ts,
    text,
    blocks,
  });
}

/**
 * Set the assistant thread status indicator.
 *
 * Shows a typing-style status below the thread (e.g. "is thinking...").
 * Pass an empty string to clear the status.
 *
 * Requires the `assistant:write` scope and "Agents & AI Apps" enabled.
 *
 * @param client - Slack WebClient
 * @param channel - Channel ID
 * @param threadTs - Thread timestamp
 * @param status - Status text (empty string to clear)
 */
export async function setThreadStatus(
  client: WebClient,
  channel: string,
  threadTs: string,
  status: string,
): Promise<void> {
  await client.assistant.threads.setStatus({
    channel_id: channel,
    thread_ts: threadTs,
    status,
  });
}
