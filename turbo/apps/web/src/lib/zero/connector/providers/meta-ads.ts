import { getConnectorOAuthConfig } from "@vm0/core/contracts/connector-utils";
import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

const META_USER_URL = "https://graph.facebook.com/v22.0/me";

interface MetaAdsUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface MetaAdsTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: MetaAdsUserInfo;
}

/**
 * Build Meta Ads OAuth authorization URL.
 * Uses Facebook Login OAuth flow with ads_management scopes.
 */
export function buildMetaAdsAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("meta-ads");
  if (!oauthConfig) {
    throw new Error("Meta Ads OAuth config not found");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    scope: oauthConfig.scopes.join(","),
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token.
 * Meta returns a short-lived token; we exchange it for a long-lived token.
 */
export async function exchangeMetaAdsCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<MetaAdsTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("meta-ads");
  if (!oauthConfig) {
    throw new Error("Meta Ads OAuth config not found");
  }

  // Step 1: Exchange code for short-lived token
  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Meta Ads", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      token_type: z.string().optional(),
      expires_in: z.number().optional(),
      error: z
        .object({
          message: z.string().optional(),
          type: z.string().optional(),
          code: z.number().optional(),
        })
        .optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error.message ?? "Meta Ads OAuth error");
  }

  if (!data.access_token) {
    throw new Error("No access token in Meta Ads response");
  }

  // Step 2: Exchange short-lived token for long-lived token
  const longLivedToken = await exchangeForLongLivedToken(
    clientId,
    clientSecret,
    data.access_token,
  );

  const userInfo = await fetchMetaAdsUserInfo(longLivedToken.accessToken);

  return {
    accessToken: longLivedToken.accessToken,
    refreshToken: null,
    expiresIn: longLivedToken.expiresIn,
    scopes: oauthConfig.scopes,
    userInfo,
  };
}

/**
 * Exchange a short-lived token for a long-lived token (~60 days).
 * Meta does not use refresh tokens; instead, long-lived tokens can be
 * refreshed by calling this endpoint again before expiry.
 */
async function exchangeForLongLivedToken(
  clientId: string,
  clientSecret: string,
  shortLivedToken: string,
): Promise<{ accessToken: string; expiresIn?: number }> {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: clientId,
    client_secret: clientSecret,
    fb_exchange_token: shortLivedToken,
  });

  const response = await fetch(
    `https://graph.facebook.com/v22.0/oauth/access_token?${params.toString()}`,
  );

  if (!response.ok) {
    await throwOAuthError("Meta Ads", "long-lived token exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      token_type: z.string().optional(),
      expires_in: z.number().optional(),
      error: z
        .object({
          message: z.string().optional(),
        })
        .optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(
      data.error.message ?? "Meta Ads long-lived token exchange error",
    );
  }

  if (!data.access_token) {
    throw new Error("No access token in Meta Ads long-lived token response");
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Fetch user info from Meta Graph API.
 */
async function fetchMetaAdsUserInfo(
  accessToken: string,
): Promise<MetaAdsUserInfo> {
  const params = new URLSearchParams({
    fields: "id,name,email",
    access_token: accessToken,
  });

  const response = await fetch(`${META_USER_URL}?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Meta Ads user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.string().optional(),
      name: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: data.id ?? "",
    username: data.name ?? null,
    email: data.email ?? null,
  };
}

/**
 * Get the primary secret name for Meta Ads connector (the access token).
 */
export function getMetaAdsSecretName(): string {
  return "META_ADS_ACCESS_TOKEN";
}
