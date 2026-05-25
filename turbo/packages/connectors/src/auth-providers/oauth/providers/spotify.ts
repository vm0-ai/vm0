import { z } from "zod";

import { getAuthCodeGrantConfig } from "../grant-config";
import { throwOAuthError } from "../error";

const SPOTIFY_AUTHORIZATION_URL = "https://accounts.spotify.com/authorize";

const SPOTIFY_ME_URL = "https://api.spotify.com/v1/me";

interface SpotifyUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface SpotifyTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: SpotifyUserInfo;
}

interface SpotifyRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

/**
 * Build Spotify OAuth authorization URL.
 */
export function buildSpotifyAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const authCodeGrant = getAuthCodeGrantConfig("spotify");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: authCodeGrant.scopes.join(" "),
    state,
  });

  return `${SPOTIFY_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Spotify requires Basic auth header (base64 of clientId:clientSecret).
 */
export async function exchangeSpotifyCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<SpotifyTokenResult> {
  const authCodeGrant = getAuthCodeGrantConfig("spotify");
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(authCodeGrant.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Spotify", "exchange", response);
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
    throw new Error("No access token in Spotify response");
  }

  const userInfo = await fetchSpotifyUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Refresh a Spotify access token using the refresh token.
 * Uses Basic auth header (base64 of clientId:clientSecret).
 */
export async function refreshSpotifyToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<SpotifyRefreshResult> {
  const authCodeGrant = getAuthCodeGrantConfig("spotify");
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(authCodeGrant.tokenUrl, {
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
    await throwOAuthError("Spotify", "refresh", response);
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
    throw new Error("No access token in Spotify refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Fetch Spotify user profile info.
 */
async function fetchSpotifyUserInfo(
  accessToken: string,
): Promise<SpotifyUserInfo> {
  const response = await fetch(SPOTIFY_ME_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Spotify user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.string().optional(),
      display_name: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: data.id ?? "",
    username: data.display_name ?? null,
    email: data.email ?? null,
  };
}

/**
 * Get the primary secret name for Spotify connector (the access token).
 */
export function getSpotifySecretName(): string {
  return "SPOTIFY_ACCESS_TOKEN";
}
