import { getConnectorOAuthConfig } from "@vm0/core";
import { z } from "zod";

const VERCEL_USERINFO_URL = "https://api.vercel.com/login/oauth/userinfo";

interface VercelUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface VercelTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: VercelUserInfo;
}

interface VercelRefreshResult {
  accessToken: string;
  refreshToken: string | null;
}

/**
 * Derive a PKCE code_verifier deterministically from the OAuth state.
 */
async function deriveCodeVerifier(state: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(state + ":vercel-pkce-verifier");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Compute the PKCE code_challenge from a code_verifier using S256.
 */
async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Base64url encode a byte array (RFC 7636).
 */
function base64UrlEncode(bytes: Uint8Array): string {
  const binString = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binString)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build Vercel OAuth2 PKCE authorization URL.
 */
export async function buildVercelAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): Promise<string> {
  const oauthConfig = getConnectorOAuthConfig("vercel");
  if (!oauthConfig) {
    throw new Error("Vercel OAuth config not found");
  }

  const codeVerifier = await deriveCodeVerifier(state);
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

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Refresh a Vercel access token using the refresh token.
 */
export async function refreshVercelToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<VercelRefreshResult> {
  const oauthConfig = getConnectorOAuthConfig("vercel");
  if (!oauthConfig) {
    throw new Error("Vercel OAuth config not found");
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
    throw new Error(`Vercel token refresh failed: ${response.status}`);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Vercel refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
  };
}

/**
 * Exchange authorization code for access token and user info with PKCE code_verifier.
 */
export async function exchangeVercelCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  state: string,
): Promise<VercelTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("vercel");
  if (!oauthConfig) {
    throw new Error("Vercel OAuth config not found");
  }

  const codeVerifier = await deriveCodeVerifier(state);

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new Error(`Vercel token exchange failed: ${response.status}`);
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
    throw new Error("No access token in Vercel response");
  }

  const userInfo = await fetchVercelUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Fetch the authenticated Vercel user's profile via the OIDC userinfo endpoint.
 */
async function fetchVercelUserInfo(
  accessToken: string,
): Promise<VercelUserInfo> {
  const response = await fetch(VERCEL_USERINFO_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Vercel user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      sub: z.string(),
      email: z.string().nullable().optional(),
      preferred_username: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: data.sub,
    username: data.preferred_username ?? data.name ?? null,
    email: data.email ?? null,
  };
}

/**
 * Get the primary secret name for Vercel connector (the access token).
 */
export function getVercelSecretName(): string {
  return "VERCEL_ACCESS_TOKEN";
}
