import type { ConnectorType } from "@vm0/connectors/connectors";
import { getConnectorOAuthConfig } from "@vm0/connectors/connector-utils";
import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

const MICROSOFT_USERINFO_URL = "https://graph.microsoft.com/v1.0/me";

interface MicrosoftUserInfo {
  id: string;
  email: string | null;
  name: string | null;
}

interface MicrosoftTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: MicrosoftUserInfo;
}

interface MicrosoftRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

/**
 * Build Microsoft OAuth authorization URL for any Microsoft connector.
 * Requests offline access to obtain a refresh token.
 */
export function buildMicrosoftAuthorizationUrl(
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
    prompt: "consent",
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info via Microsoft OAuth.
 * Uses the Microsoft Graph /me endpoint to identify the user.
 */
export async function exchangeMicrosoftOAuthCode(
  connectorType: ConnectorType,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<MicrosoftTokenResult> {
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

  const userInfo = await fetchMicrosoftUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Refresh a Microsoft access token using the refresh token.
 * Works for any Microsoft connector (Outlook Calendar, etc.).
 * Microsoft rotates refresh tokens on each refresh.
 * Access token expires_in: 3600-5400s (~75 min). Ref: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
 */
export async function refreshMicrosoftToken(
  connectorType: ConnectorType,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<MicrosoftRefreshResult> {
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
 * Fetch user info from Microsoft Graph /me endpoint.
 * Works with any Microsoft connector that includes the User.Read scope.
 */
async function fetchMicrosoftUserInfo(
  accessToken: string,
): Promise<MicrosoftUserInfo> {
  const response = await fetch(MICROSOFT_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Microsoft user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.string(),
      mail: z.string().nullable().optional(),
      userPrincipalName: z.string().nullable().optional(),
      displayName: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: data.id,
    email: data.mail ?? data.userPrincipalName ?? null,
    name: data.displayName ?? null,
  };
}
