import { NextResponse } from "next/server";
import { env } from "../../../../../../src/env";
import { getApiUrl } from "../../../../../../src/lib/infra/callback";
import { SLACK_BOT_SCOPES } from "../../../../../../src/lib/zero/slack-org/scopes";

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
 * - reinstall: "1" when triggered from "Update Permissions" (passed through
 *              OAuth state so the callback can redirect back to the Works page)
 *
 * Without orgId: Slack-initiated install → installation created with org_id = NULL.
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
  const redirectUri = `${getApiUrl()}/api/zero/slack/oauth/callback`;

  const orgId = url.searchParams.get("orgId");
  const vm0UserId = url.searchParams.get("vm0UserId");
  const reinstall = url.searchParams.get("reinstall");
  const prompt = url.searchParams.get("prompt");

  const stateObj: {
    orgId?: string;
    vm0UserId?: string;
    reinstall?: boolean;
    prompt?: string;
  } = {};
  if (orgId) stateObj.orgId = orgId;
  if (vm0UserId) stateObj.vm0UserId = vm0UserId;
  if (reinstall === "1") stateObj.reinstall = true;
  if (prompt)
    stateObj.prompt = [...prompt].slice(0, MAX_PROMPT_STATE_LENGTH).join("");
  const state =
    Object.keys(stateObj).length > 0 ? JSON.stringify(stateObj) : "";

  const authUrl = new URL(SLACK_OAUTH_URL);
  authUrl.searchParams.set("client_id", SLACK_CLIENT_ID);
  authUrl.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  authUrl.searchParams.set("redirect_uri", redirectUri);
  if (state) {
    authUrl.searchParams.set("state", state);
  }

  return NextResponse.redirect(authUrl.toString(), {
    headers: { "Cache-Control": "no-store" },
  });
}
