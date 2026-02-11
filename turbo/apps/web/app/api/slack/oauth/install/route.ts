import { NextResponse } from "next/server";
import { env } from "../../../../../src/env";
import { getSlackRedirectBaseUrl } from "../../../../../src/lib/slack";

/**
 * Slack OAuth Install Endpoint
 *
 * GET /api/slack/oauth/install
 *
 * Redirects users to Slack's OAuth authorization page to install the app
 * in their workspace.
 */

const SLACK_OAUTH_URL = "https://slack.com/oauth/v2/authorize";

// Bot scopes required for the Slack app
const BOT_SCOPES = [
  "app_mentions:read", // Read @mentions
  "chat:write", // Send messages
  "channels:history", // Read channel messages for thread context
  "groups:history", // Read private channel messages
  "im:history", // Read direct messages
  "im:write", // Send direct messages
  "commands", // Handle slash commands
  "users:read", // Get user info
  "reactions:write", // Add reactions to messages (for thinking indicator)
  "files:read", // Download files shared in messages (images, etc.)
].join(",");

export async function GET(request: Request) {
  const { SLACK_CLIENT_ID } = env();

  if (!SLACK_CLIENT_ID) {
    return NextResponse.json(
      { error: "Slack integration is not configured" },
      { status: 503 },
    );
  }

  // Get the base URL for the redirect URI
  const url = new URL(request.url);
  const baseUrl = getSlackRedirectBaseUrl(request.url);
  const redirectUri = `${baseUrl}/api/slack/oauth/callback`;

  // Get optional Slack user info, default agent, and VM0 user from query params
  const slackUserId = url.searchParams.get("u");
  const slackWorkspaceId = url.searchParams.get("w");
  const channelId = url.searchParams.get("c");
  const composeId = url.searchParams.get("composeId");
  const vm0UserId = url.searchParams.get("vm0UserId");

  // Build state with user info and default agent if provided
  const stateObj: {
    u?: string;
    w?: string;
    c?: string;
    composeId?: string;
    vm0UserId?: string;
  } = {};
  if (slackUserId) stateObj.u = slackUserId;
  if (slackWorkspaceId) stateObj.w = slackWorkspaceId;
  if (channelId) stateObj.c = channelId;
  if (composeId) stateObj.composeId = composeId;
  if (vm0UserId) stateObj.vm0UserId = vm0UserId;
  const state =
    Object.keys(stateObj).length > 0 ? JSON.stringify(stateObj) : "";

  // Build the Slack OAuth URL
  const authUrl = new URL(SLACK_OAUTH_URL);
  authUrl.searchParams.set("client_id", SLACK_CLIENT_ID);
  authUrl.searchParams.set("scope", BOT_SCOPES);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  if (state) {
    authUrl.searchParams.set("state", state);
  }

  return NextResponse.redirect(authUrl.toString());
}
