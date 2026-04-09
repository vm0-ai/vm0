import { WebClient } from "@slack/web-api";
import type { Block, KnownBlock, View } from "@slack/web-api";
import { logger } from "../../shared/logger";

const log = logger("slack:client");

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
 * Open a DM channel with a Slack user
 *
 * @param client - Slack WebClient
 * @param userId - Slack user ID
 * @returns The DM channel ID
 */
export async function openDMChannel(
  client: WebClient,
  userId: string,
): Promise<string> {
  const result = await client.conversations.open({ users: userId });
  if (!result.channel?.id) {
    throw new Error("Failed to open DM channel");
  }
  return result.channel.id;
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

export interface SlackUserInfo {
  id: string;
  name?: string;
  email?: string;
  timezone?: string;
}

/**
 * Format a SENDER block from user info.
 * Used in both thread context messages and the current-user system prompt.
 */
export function formatSenderBlock(info: SlackUserInfo): string {
  const parts = [`id: ${info.id}`];
  if (info.name) {
    parts.push(`name: ${info.name}`);
  }
  if (info.email) {
    parts.push(`email: ${info.email}`);
  }
  if (info.timezone) {
    parts.push(`timezone: ${info.timezone}`);
  }
  return `- SENDER: {${parts.join(", ")}}`;
}

/**
 * Fetch basic Slack user info (display name, email, timezone)
 *
 * @param client - Slack WebClient
 * @param userId - Slack user ID
 * @returns Structured user info, or undefined if lookup fails
 */
export async function fetchSlackUserInfo(
  client: WebClient,
  userId: string,
): Promise<SlackUserInfo | undefined> {
  const result = await client.users.info({ user: userId });
  if (!result.ok || !result.user) return undefined;

  const u = result.user;
  const name =
    u.profile?.display_name || u.profile?.real_name || u.real_name || u.name;
  const email = u.profile?.email;
  const tz = u.tz_label || u.tz;

  return {
    id: userId,
    name: name || undefined,
    email: email || undefined,
    timezone: tz || undefined,
  };
}

/**
 * Batch-resolve Slack user info for multiple user IDs.
 * Deduplicates IDs and resolves concurrently.
 */
export async function fetchSlackUserInfoMap(
  client: WebClient,
  userIds: string[],
): Promise<Map<string, SlackUserInfo>> {
  const map = new Map<string, SlackUserInfo>();
  const uniqueIds = [...new Set(userIds)];

  const results = await Promise.allSettled(
    uniqueIds.map(async (id) => {
      const info = await fetchSlackUserInfo(client, id);
      if (info) {
        map.set(id, info);
      }
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      log.warn("Failed to fetch Slack user info", { error: result.reason });
    }
  }

  return map;
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
  scope: string;
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
    scope: typeof result.scope === "string" ? result.scope : "",
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

/** Type guard for Slack API platform errors that carry a `data.error` string */
export function isSlackPlatformError(
  err: unknown,
): err is Error & { data: { error: string } } {
  if (!(err instanceof Error) || !("data" in err)) return false;
  const { data } = err as { data: unknown };
  return (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof (data as { error: unknown }).error === "string"
  );
}
