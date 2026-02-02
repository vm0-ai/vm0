import { NextResponse } from "next/server";
import { env } from "../../../../../src/env";

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
  "commands", // Handle slash commands
  "users:read", // Get user info
].join(",");

export async function GET(request: Request) {
  const { SLACK_CLIENT_ID, SLACK_REDIRECT_BASE_URL } = env();

  if (!SLACK_CLIENT_ID) {
    return NextResponse.json(
      { error: "Slack integration is not configured" },
      { status: 503 },
    );
  }

  // Get the base URL for the redirect URI
  const url = new URL(request.url);
  const baseUrl = SLACK_REDIRECT_BASE_URL ?? `${url.protocol}//${url.host}`;
  const redirectUri = `${baseUrl}/api/slack/oauth/callback`;

  // Build the Slack OAuth URL
  const authUrl = new URL(SLACK_OAUTH_URL);
  authUrl.searchParams.set("client_id", SLACK_CLIENT_ID);
  authUrl.searchParams.set("scope", BOT_SCOPES);
  authUrl.searchParams.set("redirect_uri", redirectUri);

  return NextResponse.redirect(authUrl.toString());
}
