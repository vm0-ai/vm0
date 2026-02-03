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

  // Get optional Slack user info from query params (for combined install + link flow)
  const slackUserId = url.searchParams.get("u");
  const slackWorkspaceId = url.searchParams.get("w");
  const channelId = url.searchParams.get("c");

  // Build state with user info if provided
  const stateObj: { u?: string; w?: string; c?: string } = {};
  if (slackUserId) stateObj.u = slackUserId;
  if (slackWorkspaceId) stateObj.w = slackWorkspaceId;
  if (channelId) stateObj.c = channelId;
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
