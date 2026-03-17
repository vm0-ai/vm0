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
 *
 * Uses Slack's OpenID Connect endpoint instead of the standard OAuth v2
 * endpoint so we can pass `prompt=consent` to force the authorization screen
 * every time (OAuth v2 silently auto-approves previously granted scopes).
 */

const SLACK_OIDC_URL = "https://slack.com/openid/connect/authorize";

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

  const authUrl = new URL(SLACK_OIDC_URL);
  authUrl.searchParams.set("client_id", SLACK_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  // openid is required for the OIDC endpoint; identity.basic gives us the
  // authed_user.id via oauth.v2.access which the callback already uses.
  authUrl.searchParams.set("scope", "openid");
  authUrl.searchParams.set("user_scope", "identity.basic");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  // Force Slack to always show the consent screen instead of silently
  // auto-approving previously granted scopes.
  authUrl.searchParams.set("prompt", "consent");

  return NextResponse.redirect(authUrl.toString(), {
    headers: { "Cache-Control": "no-store" },
  });
}
