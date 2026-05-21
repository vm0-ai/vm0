import { getOAuthConnectorConfig } from "@vm0/connectors/connector-utils";
import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

const AHREFS_SUBSCRIPTION_URL =
  "https://api.ahrefs.com/v3/subscription-info/limits-and-usage";

interface AhrefsUserInfo {
  id: string;
  name: string | null;
  email: string | null;
}

interface AhrefsTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: AhrefsUserInfo;
}

interface AhrefsRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

/**
 * Build Ahrefs OAuth authorization URL.
 */
export function buildAhrefsAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getOAuthConnectorConfig("ahrefs");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: oauthConfig.scopes.join(" "),
    state,
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 */
export async function exchangeAhrefsCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<AhrefsTokenResult> {
  const oauthConfig = getOAuthConnectorConfig("ahrefs");
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
    await throwOAuthError("Ahrefs", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().optional(),
      scope: z.string().optional(),
      token_type: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Ahrefs response");
  }

  const userInfo = await fetchAhrefsUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Refresh an Ahrefs access token using the refresh token.
 * Access token expires_in: returned but value undocumented. Ref: https://docs.ahrefs.com/docs/ahrefs-connect/developers/oauth-guide
 */
export async function refreshAhrefsToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<AhrefsRefreshResult> {
  const oauthConfig = getOAuthConnectorConfig("ahrefs");
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
    await throwOAuthError("Ahrefs", "refresh", response);
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
    throw new Error("No access token in Ahrefs refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Fetch Ahrefs user info using the subscription info endpoint.
 * Ahrefs doesn't have a dedicated user profile endpoint, so we use
 * the subscription info as a proxy to verify the token works.
 */
async function fetchAhrefsUserInfo(
  accessToken: string,
): Promise<AhrefsUserInfo> {
  const response = await fetch(AHREFS_SUBSCRIPTION_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Ahrefs user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      subscription: z
        .object({
          usage_type: z.string().optional(),
        })
        .optional(),
      rows_limit: z.number().optional(),
      rows_left: z.number().optional(),
    })
    .passthrough()
    .parse(await response.json());

  // Ahrefs doesn't return user ID/email from this endpoint,
  // so we use a hash of the access token as a stable identifier
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(accessToken),
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const id = hashArray
    .slice(0, 8)
    .map((b) => {
      return b.toString(16).padStart(2, "0");
    })
    .join("");

  return {
    id,
    name: data.subscription?.usage_type ?? null,
    email: null,
  };
}

/**
 * Get the primary secret name for Ahrefs connector.
 */
export function getAhrefsSecretName(): string {
  return "AHREFS_ACCESS_TOKEN";
}
