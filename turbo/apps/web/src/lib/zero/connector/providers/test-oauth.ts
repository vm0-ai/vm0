/**
 * Test OAuth provider — internal synthetic OAuth 2.0 connector.
 *
 * The "provider" is a set of routes under /api/test/oauth-provider/ in this
 * same Next.js app. URLs are resolved at runtime from NEXT_PUBLIC_APP_URL —
 * the CONNECTOR_TYPES_DEF entries' URLs are documentation-only placeholders.
 *
 * For tests only: UI is hidden by FeatureSwitchKey.TestOauthConnector, and
 * the provider routes themselves 404 in production via isAllowed().
 */

import { getConnectorOAuthConfig } from "@vm0/core";
import { z } from "zod";
import { env } from "../../../../env";
import { throwOAuthError } from "./oauth-error";

export const TEST_OAUTH_CLIENT_ID = "test-oauth-client";
export const TEST_OAUTH_CLIENT_SECRET = "test-oauth-secret";
export const TEST_OAUTH_ACCESS_SECRET_NAME = "TEST_OAUTH_ACCESS_TOKEN";
export const TEST_OAUTH_REFRESH_SECRET_NAME = "TEST_OAUTH_REFRESH_TOKEN";

interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
}

interface UserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

function resolveUrl(path: string | undefined): string {
  if (!path) {
    throw new Error("Test OAuth URL missing from CONNECTOR_TYPES_DEF");
  }
  const base = env().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  return `${base}${path}`;
}

function getAuthorizationUrl(): string {
  return resolveUrl(getConnectorOAuthConfig("test-oauth")?.authorizationUrl);
}

function getTokenUrl(): string {
  return resolveUrl(getConnectorOAuthConfig("test-oauth")?.tokenUrl);
}

export function buildTestOAuthAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "read",
    state,
  });
  return `${getAuthorizationUrl()}?${params.toString()}`;
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullable().optional(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

async function postToken(
  body: URLSearchParams,
  operation: "exchange" | "refresh",
): Promise<TokenResponse> {
  const response = await fetch(getTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    await throwOAuthError("TestOAuth", operation, response);
  }

  const data = tokenResponseSchema.parse(await response.json());

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope?.split(" ") ?? [],
  };
}

export async function exchangeTestOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    "exchange",
  );
}

export async function refreshTestOAuthToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
    "refresh",
  );
}

export async function fetchTestOAuthUserInfo(
  accessToken: string,
): Promise<UserInfo> {
  // userinfo is not part of the OAuth 2 spec's tokenUrl/authorizationUrl
  // pair so ConnectorOAuthConfig doesn't carry it. Derive from the same app.
  const base = env().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/api/test/oauth-provider/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Test OAuth userinfo failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.string(),
      username: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: data.id,
    username: data.username ?? null,
    email: data.email ?? null,
  };
}
