import { NextResponse } from "next/server";
import { env } from "../../../../../src/env";
import { getPlatformUrl } from "../../../../../src/lib/url";

/**
 * GitHub App Install Endpoint
 *
 * GET /api/github/oauth/install
 *
 * Redirects users to GitHub's App installation page where they can
 * select an organization/account and grant repository access.
 */
export async function GET(request: Request) {
  const { GITHUB_APP_SLUG } = env();

  if (!GITHUB_APP_SLUG) {
    return NextResponse.json(
      { error: "GitHub App integration is not configured" },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const vm0UserId = url.searchParams.get("vm0UserId");
  const composeId = url.searchParams.get("composeId");

  // Build state to pass through the installation flow
  const stateObj: { vm0UserId?: string; composeId?: string } = {};
  if (vm0UserId) {
    stateObj.vm0UserId = vm0UserId;
  }
  if (composeId) {
    stateObj.composeId = composeId;
  }

  const state =
    Object.keys(stateObj).length > 0 ? JSON.stringify(stateObj) : "";

  // GitHub App installation URL
  const installUrl = new URL(
    `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`,
  );
  if (state) {
    installUrl.searchParams.set("state", state);
  }

  // Set the redirect URL so GitHub sends user back to our callback
  const platformUrl = getPlatformUrl();
  installUrl.searchParams.set("redirect_uri", `${platformUrl}/github/callback`);

  return NextResponse.redirect(installUrl.toString());
}
