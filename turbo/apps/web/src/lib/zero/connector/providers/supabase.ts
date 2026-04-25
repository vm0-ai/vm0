import { getConnectorOAuthConfig } from "@vm0/api-contracts/contracts/connector-utils";
import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

const SUPABASE_ORGANIZATIONS_URL = "https://api.supabase.com/v1/organizations";

interface SupabaseUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface SupabaseTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: SupabaseUserInfo;
}

interface SupabaseRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

/**
 * Derive a PKCE code_verifier deterministically from the OAuth state.
 */
async function deriveCodeVerifier(state: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(state + ":supabase-pkce-verifier");
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
  const binString = Array.from(bytes, (b) => {
    return String.fromCharCode(b);
  }).join("");
  return btoa(binString)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build Supabase OAuth authorization URL with PKCE code_challenge.
 */
export async function buildSupabaseAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): Promise<string> {
  const oauthConfig = getConnectorOAuthConfig("supabase");
  if (!oauthConfig) {
    throw new Error("Supabase OAuth config not found");
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
 * Refresh a Supabase access token using the refresh token.
 * Supabase uses Basic Auth for token requests. PKCE is not required for refresh.
 * Access token expires_in: 3600s (1 hour, configurable). Ref: https://supabase.com/docs/guides/auth/oauth-server/oauth-flows
 */
export async function refreshSupabaseToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<SupabaseRefreshResult> {
  const oauthConfig = getConnectorOAuthConfig("supabase");
  if (!oauthConfig) {
    throw new Error("Supabase OAuth config not found");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Supabase", "refresh", response);
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
    throw new Error("No access token in Supabase refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Exchange authorization code for access token and user info with PKCE code_verifier.
 * Supabase uses Basic Auth (Base64 of clientId:clientSecret) for token exchange.
 */
export async function exchangeSupabaseCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  state: string,
): Promise<SupabaseTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("supabase");
  if (!oauthConfig) {
    throw new Error("Supabase OAuth config not found");
  }

  const codeVerifier = await deriveCodeVerifier(state);
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Supabase", "exchange", response);
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
    throw new Error("No access token in Supabase response");
  }

  const userInfo = await fetchSupabaseUserInfo(data.access_token);
  const scopes = data.scope ? data.scope.split(" ") : [];

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes,
    userInfo,
  };
}

/**
 * Fetch user info from Supabase via the organizations endpoint.
 * Supabase Management API has no dedicated profile endpoint, so we use
 * the first organization to derive user identity.
 */
async function fetchSupabaseUserInfo(
  accessToken: string,
): Promise<SupabaseUserInfo> {
  const response = await fetch(SUPABASE_ORGANIZATIONS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Supabase organizations fetch failed: ${response.status}`);
  }

  const data = z
    .array(
      z.object({
        id: z.string(),
        name: z.string().nullable().optional(),
      }),
    )
    .parse(await response.json());

  const org = data[0];

  return {
    id: org?.id ?? "",
    username: org?.name ?? null,
    email: null,
  };
}

/**
 * Get the primary secret name for Supabase connector (the access token).
 */
export function getSupabaseSecretName(): string {
  return "SUPABASE_ACCESS_TOKEN";
}
