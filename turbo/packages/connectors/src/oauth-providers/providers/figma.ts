import { getConnectorOAuthConfig } from "@vm0/connectors/connector-utils";
import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

const FIGMA_AUTHORIZATION_URL = "https://www.figma.com/oauth";

const FIGMA_ME_URL = "https://api.figma.com/v1/me";

interface FigmaUserInfo {
  id: string;
  email: string | null;
  name: string | null;
}

interface FigmaTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: FigmaUserInfo;
}

interface FigmaRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

/**
 * Build Figma OAuth authorization URL.
 */
export function buildFigmaAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("figma");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: oauthConfig.scopes.join(","),
    state,
  });

  return `${FIGMA_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Figma uses HTTP Basic Auth for token exchange.
 */
export async function exchangeFigmaCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<FigmaTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("figma");
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
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Figma", "exchange", response);
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
    throw new Error("No access token in Figma response");
  }

  const userInfo = await fetchFigmaUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: ["file_content:read"],
    userInfo,
  };
}

/**
 * Refresh a Figma access token using the refresh token.
 * Figma uses Basic Auth for token requests.
 * Returns new access token and new refresh token (both must be stored).
 * Access token expires_in: ~7776000s (90 days). Ref: https://developers.figma.com/docs/rest-api/authentication/
 */
export async function refreshFigmaToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<FigmaRefreshResult> {
  const oauthConfig = getConnectorOAuthConfig("figma");
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
    await throwOAuthError("Figma", "refresh", response);
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
    throw new Error("No access token in Figma refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Fetch Figma user info using the Figma API /me endpoint.
 */
async function fetchFigmaUserInfo(accessToken: string): Promise<FigmaUserInfo> {
  const response = await fetch(FIGMA_ME_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Figma user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.string(),
      email: z.string().nullable().optional(),
      handle: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: data.id,
    email: data.email ?? null,
    name: data.handle ?? null,
  };
}

/**
 * Get the primary secret name for Figma connector (the access token).
 */
export function getFigmaSecretName(): string {
  return "FIGMA_ACCESS_TOKEN";
}
