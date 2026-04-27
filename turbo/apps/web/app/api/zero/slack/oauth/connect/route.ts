import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { env } from "../../../../../../src/env";
import { getApiUrl } from "../../../../../../src/lib/infra/callback";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";

/**
 * Org-aware Slack OAuth Connect Endpoint
 *
 * GET /api/zero/slack/oauth/connect?orgId=<orgId>&vm0UserId=<userId>
 *
 * Redirects to Slack's OAuth authorization page so that a non-admin org member
 * can identify their Slack account.  The OAuth callback extracts the
 * `authed_user.id` from the response to create a `slackOrgConnections` record.
 *
 * Unlike the install flow, no bot scopes are requested — the app is already
 * installed.  We only need Slack to authenticate the user.
 *
 * The `team` parameter is set to the org's workspace ID so the user
 * authenticates against the correct workspace.
 */

const SLACK_OAUTH_URL = "https://slack.com/oauth/v2/authorize";

/**
 * Slack limits the OAuth `state` parameter to a conservative length. Truncate
 * the prompt we carry through the flow so a long pasted prompt can't push the
 * state past the limit.
 */
const MAX_PROMPT_STATE_LENGTH = 500;

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

  initServices();

  // Look up the workspace bound to this org so we can lock the team parameter.
  const [installation] = await globalThis.services.db
    .select({ slackWorkspaceId: slackOrgInstallations.slackWorkspaceId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, orgId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      { error: "No Slack workspace installed for this organization" },
      { status: 404 },
    );
  }

  const redirectUri = `${getApiUrl()}/api/zero/slack/oauth/callback`;
  const prompt = url.searchParams.get("prompt");

  const stateObj: {
    orgId: string;
    vm0UserId: string;
    flow: "connect";
    prompt?: string;
  } = { orgId, vm0UserId, flow: "connect" };
  if (prompt) {
    stateObj.prompt = [...prompt].slice(0, MAX_PROMPT_STATE_LENGTH).join("");
  }
  const state = JSON.stringify(stateObj);

  const authUrl = new URL(SLACK_OAUTH_URL);
  authUrl.searchParams.set("client_id", SLACK_CLIENT_ID);
  authUrl.searchParams.set("user_scope", "identity.basic");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("team", installation.slackWorkspaceId);

  return NextResponse.redirect(authUrl.toString(), {
    headers: { "Cache-Control": "no-store" },
  });
}
