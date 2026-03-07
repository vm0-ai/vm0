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

const WIX_TOKEN_URL = "https://www.wixapis.com/oauth2/token";

/**
 * Build Wix OAuth authorization URL.
 *
 * Wix uses the installer page as its OAuth consent screen. After the user
 * installs the app by clicking "Agree & Add", Wix redirects to the
 * provided redirectUri with the instanceId as a query parameter. The
 * instanceId is then exchanged for an access token via client_credentials.
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
 * Exchange instanceId for access token using client_credentials grant.
 *
 * New Wix apps use client_credentials flow instead of authorization_code.
 * The instanceId is obtained from the Dashboard page iFrame parameters
 * after the app is installed on a site.
 */
export async function exchangeWixCode(
  clientId: string,
  clientSecret: string,
  instanceId: string,
): Promise<WixTokenResult> {
  const response = await fetch(WIX_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      instance_id: instanceId,
    }).toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Wix token exchange failed: ${response.status} ${text}`);
  }

  const data = z
    .object({
      access_token: z.string(),
      token_type: z.string().optional(),
      expires_in: z.number().optional(),
    })
    .parse(await response.json());

  const userInfo = await fetchWixUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    // client_credentials flow doesn't return refresh tokens.
    // Store the instanceId as the "refresh token" so we can
    // re-request access tokens via client_credentials.
    refreshToken: instanceId,
    expiresIn: data.expires_in,
    scopes: [],
    userInfo,
  };
}

/**
 * Refresh a Wix access token.
 *
 * For new Wix apps, "refreshing" means requesting a new token
 * via client_credentials using the stored instanceId.
 */
export async function refreshWixToken(
  clientId: string,
  clientSecret: string,
  instanceId: string,
): Promise<WixRefreshResult> {
  const response = await fetch(WIX_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      instance_id: instanceId,
    }).toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Wix token refresh failed: ${response.status} ${text}`);
  }

  const data = z
    .object({
      access_token: z.string(),
      token_type: z.string().optional(),
      expires_in: z.number().optional(),
    })
    .parse(await response.json());

  return {
    accessToken: data.access_token,
    // Keep the instanceId as the refresh token
    refreshToken: instanceId,
  };
}

/**
 * Fetch Wix site owner info using the access token.
 */
async function fetchWixUserInfo(accessToken: string): Promise<WixUserInfo> {
  const response = await fetch("https://www.wixapis.com/apps/v1/instance", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
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
