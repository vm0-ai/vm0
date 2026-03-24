import { NextResponse } from "next/server";
import { env } from "../../../../../../src/env";
import { getApiUrl } from "../../../../../../src/lib/callback";

/**
 * Org-aware Slack OAuth Install Endpoint
 *
 * GET /api/zero/slack/oauth/install
 *
 * Redirects to Slack's OAuth authorization page.
 *
 * Query params:
 * - orgId:     VM0 org ID (Platform flow — admin installs from platform)
 * - vm0UserId: VM0 user ID (Platform flow)
 *
 * Without orgId: Slack-initiated install → installation created with org_id = NULL.
 */

const SLACK_OAUTH_URL = "https://slack.com/oauth/v2/authorize";

const BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "chat:write",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:history",
  "im:write",
  "commands",
  "users:read",
  "users:read.email",
  "reactions:write",
  "files:read",
  "files:write",
].join(",");

export async function GET(request: Request) {
  const { SLACK_CLIENT_ID } = env();

  if (!SLACK_CLIENT_ID) {
    return NextResponse.json(
      { error: "Slack integration is not configured" },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const redirectUri = `${getApiUrl()}/api/zero/slack/oauth/callback`;

  const orgId = url.searchParams.get("orgId");
  const vm0UserId = url.searchParams.get("vm0UserId");

  const stateObj: { orgId?: string; vm0UserId?: string } = {};
  if (orgId) stateObj.orgId = orgId;
  if (vm0UserId) stateObj.vm0UserId = vm0UserId;
  const state =
    Object.keys(stateObj).length > 0 ? JSON.stringify(stateObj) : "";

  const authUrl = new URL(SLACK_OAUTH_URL);
  authUrl.searchParams.set("client_id", SLACK_CLIENT_ID);
  authUrl.searchParams.set("scope", BOT_SCOPES);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  if (state) {
    authUrl.searchParams.set("state", state);
  }

  return NextResponse.redirect(authUrl.toString(), {
    headers: { "Cache-Control": "no-store" },
  });
}
