import { getConnectorOAuthConfig } from "@vm0/core";
import { z } from "zod";

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

/**
 * Build Figma OAuth authorization URL.
 */
export function buildFigmaAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("figma");
  if (!oauthConfig) {
    throw new Error("Figma OAuth config not found");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: oauthConfig.scopes.join(","),
    state,
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
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
  if (!oauthConfig) {
    throw new Error("Figma OAuth config not found");
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
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new Error(`Figma token exchange failed: ${response.status}`);
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
    scopes: ["files:read"],
    userInfo,
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
