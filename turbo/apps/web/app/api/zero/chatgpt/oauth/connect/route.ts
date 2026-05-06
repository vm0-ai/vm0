import { NextResponse } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { getOrigin } from "../../../../../../src/lib/shared/request/get-origin";
import { isChatgptOauthEligible } from "../../../../../../src/lib/zero/model-provider/chatgpt-oauth-eligibility";
import { buildChatgptAuthorizationUrl } from "../../../../../../src/lib/zero/connector/providers/chatgpt-oauth";
import {
  STATE_COOKIE_NAME,
  PKCE_COOKIE_NAME,
  COOKIE_MAX_AGE,
  buildCookieHeader,
} from "../_cookies";
import { serializeState } from "../_state";

/**
 * ChatGPT OAuth Connect Endpoint
 *
 * GET /api/zero/chatgpt/oauth/connect
 *
 * Builds the PKCE authorize URL for `auth.openai.com`, persists the
 * code_verifier in an HttpOnly cookie keyed for this OAuth flow, and
 * redirects (302) to the authorize URL. The user picks their workspace
 * on auth.openai.com; the callback handles the rest.
 *
 * Authorization: requires an authenticated session (via `getAuthContext`)
 * with an active org. `orgId`/`vm0UserId` are derived from the session —
 * never accepted from the client — so a caller cannot initiate OAuth for
 * an arbitrary org.
 *
 * Gated by `isChatgptOauthEligible(orgId, userId)` — returns 404 when
 * the feature switch is off so the entire surface stays hidden.
 */
export async function GET(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization") ?? undefined;
  const authCtx = await getAuthContext(authHeader);
  if (!authCtx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { org } = await resolveOrg(authCtx);
  const orgId = org.orgId;
  const vm0UserId = authCtx.userId;

  const eligible = await isChatgptOauthEligible(orgId, vm0UserId);
  if (!eligible) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const origin = getOrigin(request);
  const redirectUri = `${origin}/api/zero/chatgpt/oauth/callback`;
  const state = serializeState({ orgId, vm0UserId, flow: "connect" });

  const { url: authUrl, codeVerifier } = await buildChatgptAuthorizationUrl(
    "",
    redirectUri,
    state,
  );

  const response = NextResponse.redirect(authUrl, {
    headers: { "Cache-Control": "no-store" },
  });
  response.headers.append(
    "Set-Cookie",
    buildCookieHeader(STATE_COOKIE_NAME, state, COOKIE_MAX_AGE),
  );
  response.headers.append(
    "Set-Cookie",
    buildCookieHeader(PKCE_COOKIE_NAME, codeVerifier, COOKIE_MAX_AGE),
  );
  return response;
}
