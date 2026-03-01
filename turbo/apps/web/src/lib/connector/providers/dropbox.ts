import { getConnectorOAuthConfig } from "@vm0/core";

const DROPBOX_CURRENT_ACCOUNT_URL =
  "https://api.dropboxapi.com/2/users/get_current_account";

interface DropboxUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface DropboxTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: DropboxUserInfo;
}

/**
 * Build Dropbox OAuth authorization URL.
 * Requests offline access to obtain a refresh token.
 */
export function buildDropboxAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("dropbox");
  if (!oauthConfig) {
    throw new Error("Dropbox OAuth config not found");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: oauthConfig.scopes.join(" "),
    state,
    token_access_type: "offline",
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 */
export async function exchangeDropboxCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<DropboxTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("dropbox");
  if (!oauthConfig) {
    throw new Error("Dropbox OAuth config not found");
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
    throw new Error(`Dropbox token exchange failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string | null;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Dropbox response");
  }

  const userInfo = await fetchDropboxUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Fetch Dropbox user info using the get_current_account endpoint.
 */
async function fetchDropboxUserInfo(
  accessToken: string,
): Promise<DropboxUserInfo> {
  const response = await fetch(DROPBOX_CURRENT_ACCOUNT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Dropbox user info fetch failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    account_id?: string;
    name?: { display_name?: string | null } | null;
    email?: string | null;
  };

  return {
    id: data.account_id ?? "",
    username: data.name?.display_name ?? null,
    email: data.email ?? null,
  };
}

/**
 * Get the primary secret name for Dropbox connector (the access token).
 */
export function getDropboxSecretName(): string {
  return "DROPBOX_ACCESS_TOKEN";
}
