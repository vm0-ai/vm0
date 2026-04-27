import type { ConnectorType } from "@vm0/connectors/connectors";
import { getConnectorOAuthConfig } from "@vm0/connectors/connector-utils";
import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

interface GoogleUserInfo {
  id: string;
  email: string | null;
  name: string | null;
}

interface GoogleTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: GoogleUserInfo;
}

interface GoogleRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

/**
 * Build Google OAuth authorization URL for any Google connector.
 * Requests offline access to obtain a refresh token.
 */
export function buildGoogleAuthorizationUrl(
  connectorType: ConnectorType,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig(connectorType);
  if (!oauthConfig) {
    throw new Error(`${connectorType} OAuth config not found`);
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: oauthConfig.scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info via Google OAuth.
 * Uses the Google userinfo endpoint to identify the user.
 */
export async function exchangeGoogleOAuthCode(
  connectorType: ConnectorType,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<GoogleTokenResult> {
  const oauthConfig = getConnectorOAuthConfig(connectorType);
  if (!oauthConfig) {
    throw new Error(`${connectorType} OAuth config not found`);
  }

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    await throwOAuthError(connectorType, "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().optional(),
      scope: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error(`No access token in ${connectorType} response`);
  }

  const userInfo = await fetchGoogleUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Refresh a Google access token using the refresh token.
 * Works for any Google connector (Gmail, Sheets, Docs, Drive).
 * Returns new access token (Google does not rotate refresh tokens).
 * Access token expires_in: 3600s (1 hour). Ref: https://developers.google.com/identity/protocols/oauth2/web-server
 */
export async function refreshGoogleToken(
  connectorType: ConnectorType,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<GoogleRefreshResult> {
  const oauthConfig = getConnectorOAuthConfig(connectorType);
  if (!oauthConfig) {
    throw new Error(`${connectorType} OAuth config not found`);
  }

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError(connectorType, "refresh", response);
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
    throw new Error(`No access token in ${connectorType} refresh response`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Fetch user info from Google OAuth2 userinfo endpoint.
 * Works with any Google connector that includes the userinfo.email scope.
 */
async function fetchGoogleUserInfo(
  accessToken: string,
): Promise<GoogleUserInfo> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Google user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.string(),
      email: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: data.id,
    email: data.email ?? null,
    name: data.name ?? null,
  };
}
