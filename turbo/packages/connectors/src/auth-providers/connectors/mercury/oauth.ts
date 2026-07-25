import { z } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@vm0/connectors/connectors";
import { throwOAuthError } from "../../oauth/error";

const MERCURY_ENDPOINTS = {
  production: {
    oauthBaseUrl: "https://oauth2.mercury.com",
    apiBaseUrl: "https://api.mercury.com",
  },
  sandbox: {
    oauthBaseUrl: "https://oauth2-sandbox.mercury.com",
    apiBaseUrl: "https://api-sandbox.mercury.com",
  },
} as const;

interface MercuryEndpoints {
  oauthBaseUrl: string;
  apiBaseUrl: string;
}

/**
 * Mercury runs production and sandbox as separate OAuth2 servers, and a client
 * only exists on the one it was registered with. Set
 * MERCURY_OAUTH_ENVIRONMENT=sandbox wherever the sandbox client credentials are
 * configured, otherwise the authorization request fails with invalid_client.
 * An unset or empty value selects production; any other value is a deployment
 * misconfiguration and fails instead of silently using production.
 * Ref: https://docs.mercury.com/docs/using-mercury-sandbox
 */
function mercuryEndpoints(): MercuryEndpoints {
  const environment = process.env.MERCURY_OAUTH_ENVIRONMENT;
  if (environment === undefined || environment === "") {
    return MERCURY_ENDPOINTS.production;
  }
  if (environment === "production") {
    return MERCURY_ENDPOINTS.production;
  }
  if (environment === "sandbox") {
    return MERCURY_ENDPOINTS.sandbox;
  }
  throw new Error(
    'MERCURY_OAUTH_ENVIRONMENT must be "sandbox" or "production"',
  );
}

/**
 * Mercury registers OAuth clients with token_endpoint_auth_method
 * client_secret_basic, so credentials go in the Authorization header rather
 * than the request body.
 */
function mercuryClientAuthHeader(
  clientId: string,
  clientSecret: string,
): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

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
 * Requests every scope Mercury registered for our client: openid for the
 * authenticated user's identity, read for accounts and transactions, and
 * offline_access for a refresh token. Mercury grants read-only access only,
 * so there is no write scope to request.
 */
export function buildMercuryAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: authCodeGrant.scopes.join(" "),
    state,
  });

  return `${mercuryEndpoints().oauthBaseUrl}/oauth2/auth?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 */
export async function exchangeMercuryCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<MercuryTokenResult> {
  const response = await fetch(
    `${mercuryEndpoints().oauthBaseUrl}/oauth2/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: mercuryClientAuthHeader(clientId, clientSecret),
      },
      body: new URLSearchParams({
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    },
  );

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
  signal: AbortSignal,
): Promise<MercuryRefreshResult> {
  const response = await fetch(
    `${mercuryEndpoints().oauthBaseUrl}/oauth2/token`,
    {
      signal,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: mercuryClientAuthHeader(clientId, clientSecret),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    },
  );

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
  const response = await fetch(
    `${mercuryEndpoints().apiBaseUrl}/api/v1/accounts`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );

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
