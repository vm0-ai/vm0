import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";

/**
 * GitHub App Install Endpoint
 *
 * GET /api/github/oauth/install
 *
 * Redirects users to GitHub's App installation page where they can
 * select an organization/account and grant repository access.
 *
 * The state parameter is HMAC-signed so the callback can verify
 * it was not tampered with (prevents userId spoofing).
 */
export async function GET(request: Request) {
  initServices();

  const { GITHUB_APP_SLUG, SECRETS_ENCRYPTION_KEY } = env();

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
  const stateObj: {
    vm0UserId?: string;
    composeId?: string;
    sig?: string;
  } = {};
  if (vm0UserId) {
    stateObj.vm0UserId = vm0UserId;
  }
  if (composeId) {
    stateObj.composeId = composeId;
  }

  // Sign the state with HMAC to prevent tampering
  if (stateObj.vm0UserId) {
    const payload = `${stateObj.vm0UserId}:${stateObj.composeId ?? ""}`;
    stateObj.sig = createHmac("sha256", SECRETS_ENCRYPTION_KEY)
      .update(payload)
      .digest("hex");
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

  // Derive redirect URI from request URL (web app origin, not platform)
  const redirectUri = `${url.protocol}//${url.host}/api/github/oauth/callback`;
  installUrl.searchParams.set("redirect_uri", redirectUri);

  return NextResponse.redirect(installUrl.toString());
}
