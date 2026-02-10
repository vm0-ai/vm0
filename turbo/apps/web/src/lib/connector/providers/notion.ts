import { getConnectorOAuthConfig } from "@vm0/core";

interface NotionUserInfo {
  id: string;
  username: string;
  email: string | null;
}

interface NotionTokenResult {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  userInfo: NotionUserInfo;
}

interface NotionRefreshResult {
  accessToken: string;
  refreshToken: string | null;
}

/**
 * Encode client credentials for Notion Basic Auth header
 */
function encodeBasicAuth(clientId: string, clientSecret: string): string {
  return btoa(`${clientId}:${clientSecret}`);
}

/**
 * Build Notion OAuth authorization URL
 */
export function buildNotionAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("notion");
  if (!oauthConfig) {
    throw new Error("Notion OAuth config not found");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    owner: "user",
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Notion uses Basic Auth and JSON body (unlike GitHub's form-encoded body).
 * User info is embedded in the token response (no separate API call needed).
 */
export async function exchangeNotionCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<NotionTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("notion");
  if (!oauthConfig) {
    throw new Error("Notion OAuth config not found");
  }

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${encodeBasicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`Notion token exchange failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string | null;
    owner?: {
      user?: {
        id?: string;
        name?: string | null;
        person?: { email?: string };
      };
    };
    error?: string;
    error_description?: string;
  };

  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Notion response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    scopes: [],
    userInfo: {
      id: data.owner?.user?.id ?? "",
      username: data.owner?.user?.name ?? "",
      email: data.owner?.user?.person?.email ?? null,
    },
  };
}

/**
 * Refresh a Notion access token using the refresh token.
 * Returns new access token and new refresh token (both must be stored).
 */
export async function refreshNotionToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<NotionRefreshResult> {
  const oauthConfig = getConnectorOAuthConfig("notion");
  if (!oauthConfig) {
    throw new Error("Notion OAuth config not found");
  }

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${encodeBasicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Notion token refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string | null;
    error?: string;
    error_description?: string;
  };

  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Notion refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
  };
}

/**
 * Get the primary secret name for Notion connector (the access token).
 * Uses an explicit key rather than Object.keys() ordering to avoid
 * fragile dependency on property insertion order.
 */
export function getNotionSecretName(): string {
  return "NOTION_ACCESS_TOKEN";
}
