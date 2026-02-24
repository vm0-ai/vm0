import { WebClient, type WebAPICallResult } from "@slack/web-api";
import type { Block, KnownBlock, View } from "@slack/web-api";

const STREAM_CHUNK_SIZE = 200;
const STREAM_THROTTLE_MS = 1000;
const STREAM_MAX_PREVIEW_LENGTH = 4000;
const STREAM_MAX_UPDATES = 30;

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
 * Stream a response to Slack using progressive message updates.
 *
 * Posts an initial typing indicator, then progressively reveals content
 * via chat.update calls, and finalizes with full Block Kit formatting.
 * Falls back to a single postMessage if streaming fails.
 *
 * @param client - Slack WebClient
 * @param channel - Channel ID
 * @param text - Full response text
 * @param options - Thread timestamp, final blocks, and optional typing indicator
 */
export async function streamResponse(
  client: WebClient,
  channel: string,
  text: string,
  options: {
    threadTs: string;
    blocks: (Block | KnownBlock)[];
    typingIndicator?: string;
  },
): Promise<{ ts: string | undefined; channel: string | undefined }> {
  const initial = await client.chat.postMessage({
    channel,
    thread_ts: options.threadTs,
    text: options.typingIndicator ?? "...",
  });

  const messageTs = initial.ts;
  if (!messageTs) {
    return { ts: initial.ts, channel: initial.channel };
  }

  const previewText = text.slice(0, STREAM_MAX_PREVIEW_LENGTH);
  const chunks = splitIntoChunks(previewText, STREAM_CHUNK_SIZE);
  let accumulated = "";
  let updateCount = 0;

  for (const chunk of chunks) {
    if (updateCount >= STREAM_MAX_UPDATES) {
      break;
    }
    accumulated += chunk;
    await client.chat.update({
      channel,
      ts: messageTs,
      text: accumulated,
    });
    updateCount++;
    await sleep(STREAM_THROTTLE_MS);
  }

  await client.chat.update({
    channel,
    ts: messageTs,
    text,
    blocks: options.blocks,
  });

  return { ts: messageTs, channel: initial.channel };
}

function splitIntoChunks(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= chunkSize) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", chunkSize);
    if (splitAt === -1 || splitAt < chunkSize / 2) {
      splitAt = remaining.lastIndexOf(" ", chunkSize);
    }
    if (splitAt === -1 || splitAt < chunkSize / 2) {
      splitAt = chunkSize;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
