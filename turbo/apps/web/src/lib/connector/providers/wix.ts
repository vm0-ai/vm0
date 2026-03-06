import { z } from "zod";

interface WixUserInfo {
  id: string;
  username: string;
  email: string | null;
}

interface WixTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: WixUserInfo;
}

interface WixRefreshResult {
  accessToken: string;
  refreshToken: string | null;
}

const WIX_TOKEN_URL = "https://www.wixapis.com/oauth/access";

/**
 * Build Wix OAuth authorization URL.
 *
 * Wix uses a custom install flow instead of standard OAuth authorize.
 * The URL format is: https://www.wix.com/installer/install?appId=...&redirectUrl=...&state=...
 */
export function buildWixAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    appId: clientId,
    redirectUrl: redirectUri,
    state,
  });

  return `https://www.wix.com/installer/install?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 *
 * Wix returns `code` and `instanceId` in the callback.
 * The token endpoint accepts JSON body.
 */
export async function exchangeWixCode(
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<WixTokenResult> {
  const response = await fetch(WIX_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Wix token exchange failed: ${response.status} ${text}`);
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
    throw new Error("No access token in Wix response");
  }

  const userInfo = await fetchWixUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: [],
    userInfo,
  };
}

/**
 * Refresh a Wix access token.
 */
export async function refreshWixToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<WixRefreshResult> {
  const response = await fetch(WIX_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Wix token refresh failed: ${response.status} ${text}`);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Wix refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
  };
}

/**
 * Fetch Wix site owner info using the access token.
 */
async function fetchWixUserInfo(accessToken: string): Promise<WixUserInfo> {
  const response = await fetch("https://www.wixapis.com/apps/v1/instance", {
    headers: {
      Authorization: accessToken,
    },
  });

  if (!response.ok) {
    return { id: "unknown", username: "Wix User", email: null };
  }

  const data = z
    .object({
      instance: z
        .object({
          instanceId: z.string().optional(),
          appName: z.string().optional(),
          isFree: z.boolean().optional(),
        })
        .optional(),
      site: z
        .object({
          siteDisplayName: z.string().optional(),
          ownerEmail: z.string().optional(),
        })
        .optional(),
    })
    .parse(await response.json());

  return {
    id: data.instance?.instanceId ?? "unknown",
    username: data.site?.siteDisplayName ?? "Wix User",
    email: data.site?.ownerEmail ?? null,
  };
}

/**
 * Get the primary secret name for Wix connector.
 */
export function getWixSecretName(): string {
  return "WIX_ACCESS_TOKEN";
}
