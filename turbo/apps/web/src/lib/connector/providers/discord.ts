import { getConnectorOAuthConfig } from "@vm0/core";

const DISCORD_USER_URL = "https://discord.com/api/users/@me";

interface DiscordUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface DiscordTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: DiscordUserInfo;
}

/**
 * Build Discord OAuth authorization URL.
 */
export function buildDiscordAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("discord");
  if (!oauthConfig) {
    throw new Error("Discord OAuth config not found");
  }

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
 * Discord returns user info from a separate /users/@me endpoint.
 */
export async function exchangeDiscordCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<DiscordTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("discord");
  if (!oauthConfig) {
    throw new Error("Discord OAuth config not found");
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
    throw new Error(`Discord token exchange failed: ${response.status}`);
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
    throw new Error("No access token in Discord response");
  }

  const userInfo = await fetchDiscordUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Fetch Discord user info using the /users/@me endpoint.
 */
async function fetchDiscordUserInfo(
  accessToken: string,
): Promise<DiscordUserInfo> {
  const response = await fetch(DISCORD_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Discord user info fetch failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    id?: string;
    username?: string | null;
    global_name?: string | null;
    email?: string | null;
  };

  return {
    id: data.id ?? "",
    username: data.global_name ?? data.username ?? null,
    email: data.email ?? null,
  };
}

/**
 * Get the primary secret name for Discord connector (the access token).
 */
export function getDiscordSecretName(): string {
  return "DISCORD_ACCESS_TOKEN";
}
