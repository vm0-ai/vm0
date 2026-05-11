/* eslint-disable web/no-new-api-routes -- co-located with existing zero/me/model-providers web routes until this API group is ported */
import { NextResponse } from "next/server";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { env } from "../../../../../../../../src/env";
import { initServices } from "../../../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../../../src/lib/zero/org/resolve-org";
import { getOrigin } from "../../../../../../../../src/lib/shared/request/get-origin";
import { codexOauthHandler } from "../../../../../../../../src/lib/zero/connector/providers/codex-oauth-handler";
import { loadFeatureSwitchOverrides } from "../../../../../../../../src/lib/zero/user/feature-switches-service";

const STATE_COOKIE_NAME = "model_provider_oauth_state";
const PKCE_COOKIE_NAME = "model_provider_oauth_pkce";
const COOKIE_MAX_AGE = 15 * 60;

function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => {
    return b.toString(16).padStart(2, "0");
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
  if (env().NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
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

export async function GET(request: Request) {
  initServices();

  const origin = getOrigin(request);
  const authHeader = request.headers.get("authorization") ?? undefined;
  const authCtx = await getAuthContext(authHeader);
  if (!authCtx) {
    const loginUrl = new URL("/sign-in", origin);
    loginUrl.searchParams.set("redirect_url", request.url);
    return NextResponse.redirect(loginUrl.toString());
  }

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
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const currentEnv = env();
  const clientId = codexOauthHandler.getClientId(currentEnv);
  if (!clientId) {
    return NextResponse.json(
      { error: "OpenAI OAuth is not configured" },
      { status: 500 },
    );
  }

  const state = generateState();
  const redirectUri = `${origin}/api/zero/me/model-providers/codex-oauth-token/oauth/callback`;
  const authResult = await codexOauthHandler.buildAuthUrl(
    clientId,
    redirectUri,
    state,
  );
  const authUrl = typeof authResult === "string" ? authResult : authResult.url;
  const codeVerifier =
    typeof authResult === "string" ? undefined : authResult.codeVerifier;

  const response = NextResponse.redirect(authUrl);
  response.headers.append(
    "Set-Cookie",
    buildCookieHeader(STATE_COOKIE_NAME, state, COOKIE_MAX_AGE),
  );
  if (codeVerifier) {
    response.headers.append(
      "Set-Cookie",
      buildCookieHeader(PKCE_COOKIE_NAME, codeVerifier, COOKIE_MAX_AGE),
    );
  }
  return response;
}
