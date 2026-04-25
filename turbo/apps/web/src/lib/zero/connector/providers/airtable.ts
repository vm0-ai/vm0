import { getConnectorOAuthConfig } from "@vm0/api-contracts/contracts/connector-utils";
import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

const AIRTABLE_WHOAMI_URL = "https://api.airtable.com/v0/meta/whoami";

interface AirtableUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface AirtableTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: AirtableUserInfo;
}

interface AirtableRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

/**
 * Generate a PKCE code verifier (random 43-128 character string).
 */
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  // Base64url encode (no padding)
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Compute S256 code challenge from a code verifier.
 */
async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build Airtable OAuth authorization URL.
 * Airtable requires PKCE (code_challenge with S256 method).
 */
export async function buildAirtableAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): Promise<{ url: string; codeVerifier: string }> {
  const oauthConfig = getConnectorOAuthConfig("airtable");
  if (!oauthConfig) {
    throw new Error("Airtable OAuth config not found");
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: oauthConfig.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    url: `${oauthConfig.authorizationUrl}?${params.toString()}`,
    codeVerifier,
  };
}

/**
 * Exchange authorization code for access token and user info.
 * Airtable uses Basic auth (base64 of client_id:client_secret) for token exchange.
 */
export async function exchangeAirtableCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  codeVerifier?: string,
): Promise<AirtableTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("airtable");
  if (!oauthConfig) {
    throw new Error("Airtable OAuth config not found");
  }

  if (!codeVerifier) {
    throw new Error("Airtable requires PKCE code_verifier for token exchange");
  }

  const basicAuth = btoa(`${clientId}:${clientSecret}`);

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Airtable", "exchange", response);
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
    throw new Error("No access token in Airtable response");
  }

  const userInfo = await fetchAirtableUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Refresh an Airtable access token using the refresh token.
 * Airtable uses Basic auth for refresh as well.
 * Access token expires_in: 3600s (1 hour). Ref: https://airtable.com/developers/web/api/oauth-reference
 */
export async function refreshAirtableToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<AirtableRefreshResult> {
  const oauthConfig = getConnectorOAuthConfig("airtable");
  if (!oauthConfig) {
    throw new Error("Airtable OAuth config not found");
  }

  const basicAuth = btoa(`${clientId}:${clientSecret}`);

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Airtable", "refresh", response);
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
    throw new Error("No access token in Airtable refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Fetch Airtable user info using the whoami endpoint.
 */
async function fetchAirtableUserInfo(
  accessToken: string,
): Promise<AirtableUserInfo> {
  const response = await fetch(AIRTABLE_WHOAMI_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Airtable user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.string().optional(),
      email: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: data.id ?? "",
    username: data.email ?? null,
    email: data.email ?? null,
  };
}

/**
 * Get the primary secret name for Airtable connector (the access token).
 */
export function getAirtableSecretName(): string {
  return "AIRTABLE_ACCESS_TOKEN";
}
