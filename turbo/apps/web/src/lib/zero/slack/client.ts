import { WebClient } from "@slack/web-api";
import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("slack:client");

/**
 * Resolve the Slack Web API base URL. Returns undefined to use the
 * `@slack/web-api` default (https://slack.com/api/). E2E tests running
 * against a Vercel preview set `E2E_SLACK_MOCK_ENABLED=1` so outbound
 * traffic is redirected to `/api/test/slack-mock/` on the same deployment.
 *
 * Throws when the mock flag is set but `VERCEL_URL` is unavailable, so
 * a misconfigured preview fails loudly instead of silently hitting the
 * real `slack.com` API.
 */
function resolveSlackApiUrl(): string | undefined {
  const e = env();
  if (e.SLACK_API_URL) return e.SLACK_API_URL;
  const flag = e.E2E_SLACK_MOCK_ENABLED;
  const mockEnabled = flag === "1" || flag === "true";
  if (!mockEnabled) return undefined;
  if (!e.VERCEL_URL) {
    throw new Error(
      "E2E_SLACK_MOCK_ENABLED=1 but VERCEL_URL is unset; cannot redirect Slack Web API traffic to the preview mock routes",
    );
  }
  return `https://${e.VERCEL_URL}/api/test/slack-mock/`;
}

function buildWebClient(token?: string): WebClient {
  const slackApiUrl = resolveSlackApiUrl();
  if (!slackApiUrl) {
    return new WebClient(token);
  }
  // When the base URL is redirected to this deployment's own mock routes
  // (e2e mode), add the Vercel protection bypass header so the lambda's
  // self-requests can get past deployment protection. Without it the
  // mock endpoints return Vercel's HTML auth page and the WebClient
  // retry loop hangs until the caller times out.
  const bypass = env().VERCEL_AUTOMATION_BYPASS_SECRET;
  const headers: Record<string, string> = bypass
    ? { "x-vercel-protection-bypass": bypass }
    : {};
  return new WebClient(token, {
    slackApiUrl,
    headers,
    // Fail fast in e2e — the default retryPolicy keeps retrying on
    // network errors or 5xx for ~15s total. One retry is plenty when
    // the peer is our own mock on the same deployment.
    retryConfig: { retries: 1 },
    // Keep request timeout short so we don't silently burn the lambda
    // budget on a misrouted mock call.
    timeout: 5000,
  });
}

/**
 * Create a Slack Web API client
 *
 * @param token - Bot token or user token
 * @returns WebClient instance
 */
export function createSlackClient(token: string): WebClient {
  return buildWebClient(token);
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
