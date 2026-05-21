import { getConnectorOAuthConfig } from "@vm0/connectors/connector-utils";
import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

const DEEL_PEOPLE_ME_URL = "https://api.letsdeel.com/rest/v2/people/me";

interface DeelUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface DeelTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: DeelUserInfo;
}

interface DeelRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

/**
 * Derive a PKCE code_verifier deterministically from the OAuth state.
 */
async function deriveCodeVerifier(state: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(state + ":deel-pkce-verifier");
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
 * Build Deel OAuth authorization URL with PKCE code_challenge.
 */
export async function buildDeelAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): Promise<string> {
  const oauthConfig = getConnectorOAuthConfig("deel");
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
 * Refresh a Deel access token using the refresh token.
 * Deel uses Basic Auth for token requests. PKCE is not required for refresh.
 * Returns new access token and new refresh token (both must be stored).
 * Access token expires_in: 2592000s (30 days). Ref: https://developer.deel.com/docs/oauth2
 */
export async function refreshDeelToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<DeelRefreshResult> {
  const oauthConfig = getConnectorOAuthConfig("deel");
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
    await throwOAuthError("Deel", "refresh", response);
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
    throw new Error("No access token in Deel refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Exchange authorization code for access token and user info with PKCE code_verifier.
 */
export async function exchangeDeelCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  state: string,
): Promise<DeelTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("deel");
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
    await throwOAuthError("Deel", "exchange", response);
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
    throw new Error("No access token in Deel response");
  }

  const userInfo = await fetchDeelUserInfo(clientId, data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Fetch the current Deel user's personal profile via /rest/v2/people/me.
 * Requires the people:read scope.
 */
async function fetchDeelUserInfo(
  clientId: string,
  accessToken: string,
): Promise<DeelUserInfo> {
  const response = await fetch(DEEL_PEOPLE_ME_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-client-id": clientId,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Deel user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      data: z
        .object({
          id: z.string().optional(),
          full_name: z.string().nullable().optional(),
          first_name: z.string().nullable().optional(),
          last_name: z.string().nullable().optional(),
          emails: z
            .array(
              z.object({
                type: z.string().optional(),
                value: z.string().nullable().optional(),
              }),
            )
            .optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .parse(await response.json());

  const person = data.data;
  const name =
    person?.full_name ??
    [person?.first_name, person?.last_name].filter(Boolean).join(" ") ??
    null;
  const email = person?.emails?.[0]?.value ?? null;

  return {
    id: person?.id ?? "",
    username: name || null,
    email,
  };
}

/**
 * Get the primary secret name for Deel connector (the access token).
 */
export function getDeelSecretName(): string {
  return "DEEL_ACCESS_TOKEN";
}
