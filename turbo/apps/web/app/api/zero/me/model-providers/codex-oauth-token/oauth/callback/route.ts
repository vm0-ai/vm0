/* eslint-disable web/no-new-api-routes -- co-located with existing zero/me/model-providers web routes until this API group is ported */
import { NextResponse } from "next/server";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { initServices } from "../../../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../../../src/lib/zero/org/resolve-org";
import { getOrigin } from "../../../../../../../../src/lib/shared/request/get-origin";
import { exchangeChatgptCode } from "../../../../../../../../src/lib/zero/connector/providers/codex-oauth";
import { upsertUserMultiAuthModelProvider } from "../../../../../../../../src/lib/zero/model-provider/model-provider-service";
import { loadFeatureSwitchOverrides } from "../../../../../../../../src/lib/zero/user/feature-switches-service";

const STATE_COOKIE_NAME = "model_provider_oauth_state";
const PKCE_COOKIE_NAME = "model_provider_oauth_pkce";

function getCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;
  for (const cookie of cookieHeader.split(";")) {
    const [cookieName, ...rest] = cookie.trim().split("=");
    if (cookieName === name) {
      return rest.join("=");
    }
  }
  return undefined;
}

function buildDeleteCookieHeader(name: string): string {
  return `${name}=; Max-Age=0; Path=/`;
}

function isModelProviderOAuthEnabled(params: {
  orgId: string;
  userId: string;
  overrides: Partial<Record<FeatureSwitchKey, boolean>>;
}): boolean {
  const baseEnabled = isFeatureEnabled(
    FeatureSwitchKey.ModelFirstModelProvider,
    params,
  );
  return (
    baseEnabled && isFeatureEnabled(FeatureSwitchKey.CodexOauthProvider, params)
  );
}

function redirectWithError(
  origin: string,
  message: string,
  clearCookies = false,
): NextResponse {
  const errorUrl = new URL("/connector/error", origin);
  errorUrl.searchParams.set("type", "openai");
  errorUrl.searchParams.set("message", message);
  const response = NextResponse.redirect(errorUrl.toString());
  if (clearCookies) {
    response.headers.append(
      "Set-Cookie",
      buildDeleteCookieHeader(STATE_COOKIE_NAME),
    );
    response.headers.append(
      "Set-Cookie",
      buildDeleteCookieHeader(PKCE_COOKIE_NAME),
    );
  }
  return response;
}

export async function GET(request: Request) {
  initServices();

  const origin = getOrigin(request);
  const url = new URL(request.url);
  const authHeader = request.headers.get("authorization") ?? undefined;
  const authCtx = await getAuthContext(authHeader);
  if (!authCtx) {
    return redirectWithError(origin, "Not authenticated", true);
  }

  const savedState = getCookie(request, STATE_COOKIE_NAME);
  const codeVerifier = getCookie(request, PKCE_COOKIE_NAME);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return redirectWithError(
      origin,
      errorDescription || error || "OAuth authorization failed",
      true,
    );
  }
  if (!code) {
    return redirectWithError(origin, "Missing authorization code", true);
  }
  if (!state || state !== savedState) {
    return redirectWithError(origin, "Invalid state - please try again", true);
  }
  if (!codeVerifier) {
    return redirectWithError(origin, "Missing PKCE verifier", true);
  }

  try {
    const { org } = await resolveOrg(authCtx);
    const overrides =
      (await loadFeatureSwitchOverrides(org.orgId, authCtx.userId)) ?? {};
    if (
      !isModelProviderOAuthEnabled({
        orgId: org.orgId,
        userId: authCtx.userId,
        overrides,
      })
    ) {
      return redirectWithError(origin, "OpenAI OAuth is not available", true);
    }

    const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
    const redirectUri = `${origin}/api/zero/me/model-providers/codex-oauth-token/oauth/callback`;
    const result = await exchangeChatgptCode(
      clientId,
      code,
      redirectUri,
      codeVerifier,
    );

    await upsertUserMultiAuthModelProvider(
      org.orgId,
      authCtx.userId,
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
        tokenExpiresAt: result.tokenExpiresAt,
        workspaceName: result.workspaceName,
        planType: result.planType,
      },
    );

    const successUrl = new URL("/connector/success", origin);
    successUrl.searchParams.set("type", "openai");
    successUrl.searchParams.set(
      "username",
      result.workspaceName ?? result.userInfo.email ?? "OpenAI",
    );
    const response = NextResponse.redirect(successUrl.toString());
    response.headers.append(
      "Set-Cookie",
      buildDeleteCookieHeader(STATE_COOKIE_NAME),
    );
    response.headers.append(
      "Set-Cookie",
      buildDeleteCookieHeader(PKCE_COOKIE_NAME),
    );
    return response;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "OAuth authorization failed";
    return redirectWithError(origin, message, true);
  }
}
