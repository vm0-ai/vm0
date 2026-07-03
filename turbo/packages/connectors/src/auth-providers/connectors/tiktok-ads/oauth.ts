import { z } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@vm0/connectors/connectors";
import { throwOAuthError } from "../../oauth/error";

const TIKTOK_ADS_AUTHORIZATION_URL =
  "https://business-api.tiktok.com/portal/auth";
const TIKTOK_ADS_TOKEN_URL =
  "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/";
const TIKTOK_ADS_REFRESH_URL =
  "https://business-api.tiktok.com/open_api/v1.3/oauth2/refresh_token/";

interface TikTokAdsUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface TikTokAdsTokenResult {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  scopes: string[];
  userInfo: TikTokAdsUserInfo;
}

interface TikTokAdsRefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

const tiktokAdsTokenResponseSchema = z
  .object({
    code: z.number().optional(),
    message: z.string().optional(),
    request_id: z.string().optional(),
    data: z
      .object({
        access_token: z.string().optional(),
        refresh_token: z.string().optional(),
        expires_in: z.number().optional(),
        advertiser_ids: z.array(z.union([z.string(), z.number()])).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function throwTikTokAdsApiError(
  data: z.infer<typeof tiktokAdsTokenResponseSchema>,
  operation: string,
): void {
  if (data.code === undefined || data.code === 0) {
    return;
  }
  throw new Error(data.message ?? `TikTok Ads ${operation} failed`);
}

function userInfoFromAdvertiserIds(
  advertiserIds: readonly (string | number)[] | undefined,
): TikTokAdsUserInfo {
  const advertiserId =
    advertiserIds?.[0] !== undefined ? String(advertiserIds[0]) : "tiktok-ads";
  return {
    id: advertiserId,
    username: advertiserId === "tiktok-ads" ? "TikTok Ads" : advertiserId,
    email: null,
  };
}

/**
 * Build TikTok Ads advertiser authorization URL.
 * TikTok Business redirects back with `auth_code`, which the API callback
 * accepts as an alias for standard OAuth `code`.
 */
export function buildTikTokAdsAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    app_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  if (authCodeGrant.scopes.length > 0) {
    params.set("scope", authCodeGrant.scopes.join(","));
  }

  return `${TIKTOK_ADS_AUTHORIZATION_URL}?${params.toString()}`;
}

export async function exchangeTikTokAdsCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<TikTokAdsTokenResult> {
  const response = await fetch(TIKTOK_ADS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      app_id: clientId,
      secret: clientSecret,
      auth_code: code,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("TikTok Ads", "exchange", response);
  }

  const data = tiktokAdsTokenResponseSchema.parse(await response.json());
  throwTikTokAdsApiError(data, "token exchange");

  if (!data.data?.access_token) {
    throw new Error("No access token in TikTok Ads response");
  }
  if (!data.data.refresh_token) {
    throw new Error("No refresh token in TikTok Ads response");
  }

  return {
    accessToken: data.data.access_token,
    refreshToken: data.data.refresh_token,
    expiresIn: data.data.expires_in,
    scopes: authCodeGrant.scopes,
    userInfo: userInfoFromAdvertiserIds(data.data.advertiser_ids),
  };
}

export async function refreshTikTokAdsToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<TikTokAdsRefreshResult> {
  const response = await fetch(TIKTOK_ADS_REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      app_id: clientId,
      secret: clientSecret,
      refresh_token: refreshToken,
    }),
    signal,
  });

  if (!response.ok) {
    await throwOAuthError("TikTok Ads", "refresh", response);
  }

  const data = tiktokAdsTokenResponseSchema.parse(await response.json());
  throwTikTokAdsApiError(data, "token refresh");

  if (!data.data?.access_token) {
    throw new Error("No access token in TikTok Ads refresh response");
  }

  return {
    accessToken: data.data.access_token,
    refreshToken: data.data.refresh_token,
    expiresIn: data.data.expires_in,
  };
}
