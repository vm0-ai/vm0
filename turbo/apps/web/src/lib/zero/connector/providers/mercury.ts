import { getConnectorOAuthConfig } from "@vm0/api-contracts/contracts/connector-utils";
import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

const MERCURY_ACCOUNTS_URL = "https://api.mercury.com/api/v1/accounts";

interface MercuryUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface MercuryTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: MercuryUserInfo;
}

interface MercuryRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

/**
 * Build Mercury OAuth authorization URL.
 * Requests offline_access scope to obtain a refresh token.
 */
export function buildMercuryAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("mercury");
  if (!oauthConfig) {
    throw new Error("Mercury OAuth config not found");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: oauthConfig.scopes.join(" "),
    state,
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 */
export async function exchangeMercuryCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<MercuryTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("mercury");
  if (!oauthConfig) {
    throw new Error("Mercury OAuth config not found");
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
    await throwOAuthError("Mercury", "exchange", response);
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
    throw new Error("No access token in Mercury response");
  }

  const userInfo = await fetchMercuryUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Refresh a Mercury access token using the refresh token.
 * Returns new access token and new refresh token (both must be stored).
 * Access token expires_in: 3600s (1 hour). Ref: https://docs.mercury.com/reference/obtain-the-tokens
 */
export async function refreshMercuryToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<MercuryRefreshResult> {
  const oauthConfig = getConnectorOAuthConfig("mercury");
  if (!oauthConfig) {
    throw new Error("Mercury OAuth config not found");
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
    await throwOAuthError("Mercury", "refresh", response);
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
    throw new Error("No access token in Mercury refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Fetch Mercury user info using the accounts endpoint.
 * Mercury does not have a dedicated user profile endpoint,
 * so we use the first account's details as identity.
 */
async function fetchMercuryUserInfo(
  accessToken: string,
): Promise<MercuryUserInfo> {
  const response = await fetch(MERCURY_ACCOUNTS_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Mercury user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      accounts: z
        .array(
          z.object({
            id: z.string().optional(),
            name: z.string().nullable().optional(),
            legalBusinessName: z.string().nullable().optional(),
          }),
        )
        .optional(),
    })
    .parse(await response.json());

  const firstAccount = data.accounts?.[0];

  return {
    id: firstAccount?.id ?? "",
    username: firstAccount?.name ?? firstAccount?.legalBusinessName ?? null,
    email: null,
  };
}

/**
 * Get the primary secret name for Mercury connector (the access token).
 */
export function getMercurySecretName(): string {
  return "MERCURY_ACCESS_TOKEN";
}
