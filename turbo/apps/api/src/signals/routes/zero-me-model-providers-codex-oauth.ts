import { command } from "ccstate";
import { zeroPersonalModelProvidersCodexOauthContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { requiredAuthContext$ } from "../auth/auth-context";
import { queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { env } from "../../lib/env";
import {
  buildChatgptAuthorizationUrl,
  exchangeChatgptCode,
  getChatgptOAuthClientId,
} from "../services/codex-oauth-browser.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { upsertUserMultiAuthModelProvider$ } from "../services/zero-model-provider.service";
import { safeAsync } from "../utils";
import type { RouteEntry } from "../route";

const STATE_COOKIE_NAME = "model_provider_oauth_state";
const PKCE_COOKIE_NAME = "model_provider_oauth_pkce";
const COOKIE_MAX_AGE = 15 * 60;
const REDIRECT_STATUS = 307;

function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

function buildCookieHeader(
  name: string,
  value: string,
  maxAge: number,
): string {
  const parts = [
    `${name}=${value}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (env("ENV") === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function buildDeleteCookieHeader(name: string): string {
  return `${name}=; Max-Age=0; Path=/`;
}

function getCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return undefined;
  }
  for (const cookie of cookieHeader.split(";")) {
    const [cookieName, ...rest] = cookie.trim().split("=");
    if (cookieName === name) {
      return rest.join("=");
    }
  }
  return undefined;
}

function getRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedHost) {
    return `${forwardedProto ?? "https"}://${forwardedHost}`;
  }
  return url.origin;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url },
  });
}

function redirectWithError(
  origin: string,
  message: string,
  clearCookies = false,
): Response {
  const errorUrl = new URL("/connector/error", origin);
  errorUrl.searchParams.set("type", "openai");
  errorUrl.searchParams.set("message", message);
  const response = redirectResponse(errorUrl.toString());
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

function featureDisabledResponse(): Response {
  return jsonResponse({ error: "Not found" }, 404);
}

function missingOrganizationResponse(): Response {
  return jsonResponse(
    {
      error: {
        message: "Explicit org context required - ensure active org in session",
        code: "BAD_REQUEST",
      },
    },
    400,
  );
}

function isModelProviderOAuthEnabled(
  params: Parameters<typeof isFeatureEnabled>[1],
): boolean {
  return (
    isFeatureEnabled(FeatureSwitchKey.ModelFirstModelProvider, params) &&
    isFeatureEnabled(FeatureSwitchKey.CodexOauthProvider, params)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "OAuth authorization failed";
}

const authorizeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$).raw;
  const origin = getRequestOrigin(request);
  const requestUrl = new URL(request.url);

  const auth = await set(
    requiredAuthContext$,
    { requireOrganization: true, missingOrganizationStatus: 401 },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in auth) {
    if (auth.status === 401) {
      const loginUrl = new URL("/sign-in", origin);
      const redirectUrl = new URL(
        `${requestUrl.pathname}${requestUrl.search}`,
        origin,
      );
      loginUrl.searchParams.set("redirect_url", redirectUrl.toString());
      return redirectResponse(loginUrl.toString());
    }
    return jsonResponse(auth.body, auth.status);
  }
  if (!auth.orgId) {
    return missingOrganizationResponse();
  }

  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isModelProviderOAuthEnabled({
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    return featureDisabledResponse();
  }

  const state = generateState();
  const clientId = getChatgptOAuthClientId();
  const authResult = await buildChatgptAuthorizationUrl({
    clientId,
    redirectUri: `${origin}/api/zero/me/model-providers/codex-oauth-token/oauth/callback`,
    state,
  });
  signal.throwIfAborted();

  const response = redirectResponse(authResult.url);
  response.headers.append(
    "Set-Cookie",
    buildCookieHeader(STATE_COOKIE_NAME, state, COOKIE_MAX_AGE),
  );
  response.headers.append(
    "Set-Cookie",
    buildCookieHeader(
      PKCE_COOKIE_NAME,
      authResult.codeVerifier,
      COOKIE_MAX_AGE,
    ),
  );
  return response;
});

const callbackInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$).raw;
  const origin = getRequestOrigin(request);
  const query = get(
    queryOf(zeroPersonalModelProvidersCodexOauthContract.callback),
  );

  const auth = await set(
    requiredAuthContext$,
    { requireOrganization: true, missingOrganizationStatus: 401 },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in auth) {
    return redirectWithError(origin, auth.body.error.message, true);
  }
  if (!auth.orgId) {
    return redirectWithError(
      origin,
      "Explicit org context required - ensure active org in session",
      true,
    );
  }

  const savedState = getCookie(request, STATE_COOKIE_NAME);
  const codeVerifier = getCookie(request, PKCE_COOKIE_NAME);

  if (query.error) {
    return redirectWithError(
      origin,
      query.error_description ?? query.error,
      true,
    );
  }
  if (!query.code) {
    return redirectWithError(origin, "Missing authorization code", true);
  }
  const authorizationCode = query.code;
  if (!query.state || query.state !== savedState) {
    return redirectWithError(origin, "Invalid state - please try again", true);
  }
  if (!codeVerifier) {
    return redirectWithError(origin, "Missing PKCE verifier", true);
  }

  const result = await safeAsync(async () => {
    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    if (
      !isModelProviderOAuthEnabled({
        orgId: auth.orgId,
        userId: auth.userId,
        overrides,
      })
    ) {
      return redirectWithError(origin, "OpenAI OAuth is not available", true);
    }

    const exchangeResult = await exchangeChatgptCode({
      clientId: getChatgptOAuthClientId(),
      code: authorizationCode,
      redirectUri: `${origin}/api/zero/me/model-providers/codex-oauth-token/oauth/callback`,
      codeVerifier,
    });
    signal.throwIfAborted();

    const upsertResult = await set(
      upsertUserMultiAuthModelProvider$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        type: "codex-oauth-token",
        authMethod: "oauth",
        secretValues: {
          CHATGPT_ACCESS_TOKEN: exchangeResult.accessToken,
          CHATGPT_REFRESH_TOKEN: exchangeResult.refreshToken,
          CHATGPT_ACCOUNT_ID: exchangeResult.accountId,
          CHATGPT_ID_TOKEN: exchangeResult.idToken,
        },
        metadata: {
          tokenExpiresAt: exchangeResult.tokenExpiresAt,
          workspaceName: exchangeResult.workspaceName,
          planType: exchangeResult.planType,
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in upsertResult) {
      throw new Error(upsertResult.body.error.message);
    }

    const successUrl = new URL("/connector/success", origin);
    successUrl.searchParams.set("type", "openai");
    successUrl.searchParams.set(
      "username",
      exchangeResult.workspaceName ?? exchangeResult.userInfo.email ?? "OpenAI",
    );
    const response = redirectResponse(successUrl.toString());
    response.headers.append(
      "Set-Cookie",
      buildDeleteCookieHeader(STATE_COOKIE_NAME),
    );
    response.headers.append(
      "Set-Cookie",
      buildDeleteCookieHeader(PKCE_COOKIE_NAME),
    );
    return response;
  });
  signal.throwIfAborted();

  if ("error" in result) {
    return redirectWithError(origin, errorMessage(result.error), true);
  }
  return result.ok;
});

export const zeroMeModelProvidersCodexOauthRoutes: readonly RouteEntry[] = [
  {
    route: zeroPersonalModelProvidersCodexOauthContract.authorize,
    handler: authorizeInner$,
  },
  {
    route: zeroPersonalModelProvidersCodexOauthContract.callback,
    handler: callbackInner$,
  },
];
