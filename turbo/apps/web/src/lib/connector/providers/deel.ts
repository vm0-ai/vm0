import { getConnectorOAuthConfig } from "@vm0/core";
import { z } from "zod";

const DEEL_LEGAL_ENTITIES_URL = "https://api.deel.com/rest/v2/legal-entities";

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

/**
 * Build Deel OAuth authorization URL.
 */
export function buildDeelAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("deel");
  if (!oauthConfig) {
    throw new Error("Deel OAuth config not found");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 */
export async function exchangeDeelCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<DeelTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("deel");
  if (!oauthConfig) {
    throw new Error("Deel OAuth config not found");
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
    throw new Error(`Deel token exchange failed: ${response.status}`);
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

  const userInfo = await fetchDeelUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Fetch Deel user info using the legal-entities endpoint.
 * Deel does not expose a /me endpoint, so we use legal-entities
 * as a lightweight way to identify the connected organization.
 */
async function fetchDeelUserInfo(accessToken: string): Promise<DeelUserInfo> {
  const response = await fetch(DEEL_LEGAL_ENTITIES_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Deel user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      data: z
        .array(
          z.object({
            id: z.string().optional(),
            legal_name: z.string().nullable().optional(),
          }),
        )
        .optional(),
    })
    .parse(await response.json());

  const entity = data.data?.[0];

  return {
    id: entity?.id ?? "",
    username: entity?.legal_name ?? null,
    email: null,
  };
}

/**
 * Get the primary secret name for Deel connector (the access token).
 */
export function getDeelSecretName(): string {
  return "DEEL_ACCESS_TOKEN";
}
