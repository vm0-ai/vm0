import { NextResponse } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { getOrigin } from "../../../../../../src/lib/shared/request/get-origin";
import { getAppUrl } from "../../../../../../src/lib/zero/url";
import { logger } from "../../../../../../src/lib/shared/logger";
import { isCodexOauthEligible } from "../../../../../../src/lib/zero/model-provider/codex-oauth-eligibility";
import {
  exchangeChatgptCode,
  isChatgptFreePlanError,
} from "../../../../../../src/lib/zero/connector/providers/codex-oauth";
import { upsertOrgMultiAuthModelProvider } from "../../../../../../src/lib/zero/model-provider/model-provider-service";
import {
  STATE_COOKIE_NAME,
  PKCE_COOKIE_NAME,
  buildDeleteCookieHeader,
  getCookie,
} from "../_cookies";
import { parseState } from "../_state";

const log = logger("api:zero-codex-oauth-callback");

/**
 * ChatGPT OAuth Callback Endpoint
 *
 * GET /api/zero/chatgpt/oauth/callback?code=...&state=...&error=...
 *
 * 1. Require an authenticated session (matches the connect-time session).
 * 2. Validate state matches the cookie set at connect time (CSRF).
 * 3. Bind state to the auth context: state.orgId/vm0UserId MUST match the
 *    resolved org and authenticated user — prevents an attacker from
 *    completing OAuth against an org they don't belong to.
 * 4. Re-check eligibility (in case the feature switch was disabled mid-flow).
 * 5. Exchange code → tokens via PKCE (uses code_verifier from cookie).
 * 6. Reject free-plan accounts with a clear redirect.
 * 7. Persist the 4 secrets via upsertOrgMultiAuthModelProvider.
 * 8. Redirect to the model-providers settings page.
 *
 * `CHATGPT_REFRESH_TOKEN` and `CHATGPT_ID_TOKEN` are flagged `serverOnly`
 * in the model-provider type definition; the runner-secret-forwarding
 * pipeline strips them before sandbox dispatch (per #7365 invariant).
 */
export async function GET(request: Request) {
  initServices();

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const stateParam = url.searchParams.get("state");
  const origin = getOrigin(request);
  const appUrl = getAppUrl();

  // Always clear OAuth cookies on the way out — applies to every branch
  // below regardless of success.
  const clearCookies = (response: NextResponse): NextResponse => {
    response.headers.append(
      "Set-Cookie",
      buildDeleteCookieHeader(STATE_COOKIE_NAME),
    );
    response.headers.append(
      "Set-Cookie",
      buildDeleteCookieHeader(PKCE_COOKIE_NAME),
    );
    return response;
  };

  const authHeader = request.headers.get("authorization") ?? undefined;
  const authCtx = await getAuthContext(authHeader);
  if (!authCtx) {
    return clearCookies(redirectError(appUrl, "unauthenticated"));
  }
  const { org } = await resolveOrg(authCtx);

  if (error) {
    return clearCookies(redirectError(appUrl, error));
  }

  if (!code || !stateParam) {
    return clearCookies(redirectError(appUrl, "missing_params"));
  }

  const savedState = getCookie(request, STATE_COOKIE_NAME);
  if (!savedState || savedState !== stateParam) {
    return clearCookies(redirectError(appUrl, "state_mismatch"));
  }

  const state = parseState(stateParam);
  if (!state) {
    return clearCookies(redirectError(appUrl, "invalid_state"));
  }

  // Bind state to the auth context. The state cookie is HttpOnly + SameSite=Lax,
  // but we still verify the encoded orgId/vm0UserId match the authenticated
  // session — defense-in-depth against any path that might let an attacker
  // forge or replay a state cookie for another org.
  if (state.orgId !== org.orgId || state.vm0UserId !== authCtx.userId) {
    return clearCookies(redirectError(appUrl, "state_mismatch"));
  }

  const eligible = await isCodexOauthEligible(state.orgId, state.vm0UserId);
  if (!eligible) {
    return clearCookies(redirectError(appUrl, "ineligible"));
  }

  const codeVerifier = getCookie(request, PKCE_COOKIE_NAME);
  if (!codeVerifier) {
    return clearCookies(redirectError(appUrl, "expired"));
  }

  const redirectUri = `${origin}/api/zero/chatgpt/oauth/callback`;

  let result;
  try {
    result = await exchangeChatgptCode("", "", code, redirectUri, codeVerifier);
  } catch (err) {
    if (isChatgptFreePlanError(err)) {
      log.info("Rejected free-plan ChatGPT OAuth", { orgId: state.orgId });
      return clearCookies(redirectError(appUrl, "free_plan"));
    }
    log.warn("ChatGPT OAuth exchange failed", { error: err });
    return clearCookies(redirectError(appUrl, "exchange_failed"));
  }

  // Persist the 4 secrets PLUS OAuth metadata. Passing the metadata also
  // clears any pre-existing needsReconnect/lastRefreshErrorCode atomically
  // (re-OAuth IS the recovery path for stale providers).
  await upsertOrgMultiAuthModelProvider(
    state.orgId,
    "codex-oauth-token",
    "oauth",
    {
      CHATGPT_ACCESS_TOKEN: result.accessToken,
      CHATGPT_REFRESH_TOKEN: result.refreshToken,
      CHATGPT_ACCOUNT_ID: result.accountId,
      CHATGPT_ID_TOKEN: result.idToken,
    },
    undefined,
    {
      tokenExpiresAt: new Date(Date.now() + result.expiresIn * 1000),
      workspaceName: result.workspaceName,
      planType: result.planType,
    },
  );

  log.info("ChatGPT OAuth provider connected", {
    orgId: state.orgId,
    workspaceName: result.workspaceName,
    planType: result.planType,
  });

  const successUrl = new URL("/settings/model-providers", appUrl);
  successUrl.searchParams.set("connected", "chatgpt");
  return clearCookies(NextResponse.redirect(successUrl.toString()));
}

function redirectError(appUrl: string, code: string): NextResponse {
  const url = new URL("/settings/model-providers", appUrl);
  url.searchParams.set("error", code);
  return NextResponse.redirect(url.toString());
}
