import { NextResponse } from "next/server";
import { env } from "../../../../../../src/env";
import { getSlackRedirectBaseUrl } from "../../../../../../src/lib/slack";

/**
 * Org-aware Slack OAuth Connect Endpoint
 *
 * GET /api/slack/org/oauth/connect?orgId=<orgId>&vm0UserId=<userId>
 *
 * Redirects to Slack's OAuth authorization page so that a non-admin org member
 * can identify their Slack account.  The OAuth callback extracts the
 * `authed_user.id` from the response to create a `slackOrgConnections` record.
 *
 * Unlike the install flow, no bot scopes are requested — the app is already
 * installed.  We only need Slack to authenticate the user.
 */

const SLACK_OAUTH_URL = "https://slack.com/oauth/v2/authorize";

export async function GET(request: Request) {
  const { SLACK_CLIENT_ID } = env();

  if (!SLACK_CLIENT_ID) {
    return NextResponse.json(
      { error: "Slack integration is not configured" },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const orgId = url.searchParams.get("orgId");
  const vm0UserId = url.searchParams.get("vm0UserId");

  if (!orgId || !vm0UserId) {
    return NextResponse.json(
      { error: "Missing orgId or vm0UserId" },
      { status: 400 },
    );
  }

  const baseUrl = getSlackRedirectBaseUrl(request.url);
  const redirectUri = `${baseUrl}/api/slack/org/oauth/callback`;

  const state = JSON.stringify({ orgId, vm0UserId, flow: "connect" });

  const authUrl = new URL(SLACK_OAUTH_URL);
  authUrl.searchParams.set("client_id", SLACK_CLIENT_ID);
  // No bot scopes — app is already installed.
  // Request minimal user scope so Slack shows the consent screen and
  // returns the authed_user.id we need to create the connection.
  authUrl.searchParams.set("user_scope", "identity.basic");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);

  return NextResponse.redirect(authUrl.toString(), {
    headers: { "Cache-Control": "no-store" },
  });
}
