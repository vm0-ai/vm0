import { getConnectorOAuthConfig } from "@vm0/core";
import { z } from "zod";

const WEBFLOW_USER_INFO_URL = "https://api.webflow.com/v2/token/authorized_by";

interface WebflowUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface WebflowTokenResult {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  userInfo: WebflowUserInfo;
}

/**
 * Build Webflow OAuth authorization URL
 */
export function buildWebflowAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("webflow");
  if (!oauthConfig) {
    throw new Error("Webflow OAuth config not found");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: oauthConfig.scopes.join(" "),
    state,
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Webflow uses JSON body for the token exchange and does not issue refresh tokens.
 */
export async function exchangeWebflowCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<WebflowTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("webflow");
  if (!oauthConfig) {
    throw new Error("Webflow OAuth config not found");
  }

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new Error(`Webflow token exchange failed: ${response.status}`);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      token_type: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Webflow response");
  }

  const userInfo = await fetchWebflowUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: null,
    scopes: oauthConfig.scopes,
    userInfo,
  };
}

/**
 * Fetch Webflow authorized user info.
 */
async function fetchWebflowUserInfo(
  accessToken: string,
): Promise<WebflowUserInfo> {
  const response = await fetch(WEBFLOW_USER_INFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Webflow user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.string().optional(),
      email: z.string().optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
    })
    .parse(await response.json());

  const name =
    [data.firstName, data.lastName].filter(Boolean).join(" ") || null;

  return {
    id: data.id ?? "",
    username: name,
    email: data.email ?? null,
  };
}

/**
 * Get the primary secret name for Webflow connector (the access token).
 */
export function getWebflowSecretName(): string {
  return "WEBFLOW_ACCESS_TOKEN";
}
