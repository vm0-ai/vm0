import { CONNECTOR_TYPES, getConnectorOAuthConfig } from "@vm0/core";

const GITHUB_API_BASE = "https://api.github.com";

interface GitHubUserInfo {
  id: string;
  username: string;
  email: string | null;
}

/**
 * Build GitHub OAuth authorization URL
 */
export function buildGitHubAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("github");
  if (!oauthConfig) {
    throw new Error("GitHub OAuth config not found");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: oauthConfig.scopes.join(" "),
    state,
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 */
export async function exchangeGitHubCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; scopes: string[] }> {
  const oauthConfig = getConnectorOAuthConfig("github");
  if (!oauthConfig) {
    throw new Error("GitHub OAuth config not found");
  }

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in GitHub response");
  }

  return {
    accessToken: data.access_token,
    scopes: data.scope ? data.scope.split(",") : [],
  };
}

/**
 * Fetch GitHub user info using access token
 */
export async function fetchGitHubUserInfo(
  accessToken: string,
): Promise<GitHubUserInfo> {
  const response = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub user API failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    id: number;
    login: string;
    email: string | null;
  };

  return {
    id: String(data.id),
    username: data.login,
    email: data.email,
  };
}

/**
 * Get secret name for GitHub connector
 */
export function getGitHubSecretName(): string {
  const oauthMethod = CONNECTOR_TYPES.github.authMethods.oauth;
  if (!oauthMethod) {
    throw new Error("GitHub OAuth auth method not found");
  }
  const secretNames = Object.keys(oauthMethod.secrets);
  const firstSecret = secretNames[0];
  if (!firstSecret) {
    throw new Error("GitHub OAuth secrets not configured");
  }
  return firstSecret;
}
