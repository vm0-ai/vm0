import { getConnectorOAuthConfig } from "@vm0/connectors/connector-utils";
import { z } from "zod";
import { throwOAuthError } from "../error";

const SENTRY_AUTHORIZATION_URL = "https://sentry.io/oauth/authorize/";

interface SentryUserInfo {
  id: string;
  name: string | null;
  email: string | null;
}

interface SentryTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: SentryUserInfo;
}

interface SentryRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

/**
 * Build Sentry OAuth authorization URL.
 */
export function buildSentryAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("sentry");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: oauthConfig.scopes.join(" "),
    state,
  });

  return `${SENTRY_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Sentry embeds user info directly in the token response.
 */
export async function exchangeSentryCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<SentryTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("sentry");
  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Sentry", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().optional(),
      scope: z.string().optional(),
      token_type: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
      user: z
        .object({
          id: z.string(),
          name: z.string().nullable().optional(),
          email: z.string().nullable().optional(),
        })
        .optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Sentry response");
  }

  if (!data.user) {
    throw new Error("No user info in Sentry token response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo: {
      id: data.user.id,
      name: data.user.name ?? null,
      email: data.user.email ?? null,
    },
  };
}

/**
 * Refresh a Sentry access token using the refresh token.
 * Access token expires_in: ~2592000s (30 days). Ref: https://docs.sentry.io/api/auth/
 */
export async function refreshSentryToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<SentryRefreshResult> {
  const oauthConfig = getConnectorOAuthConfig("sentry");
  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Sentry", "refresh", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Sentry refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Get the primary secret name for Sentry connector (the access token).
 */
export function getSentrySecretName(): string {
  return "SENTRY_ACCESS_TOKEN";
}
