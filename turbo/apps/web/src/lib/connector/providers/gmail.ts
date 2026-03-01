import { getConnectorOAuthConfig } from "@vm0/core";

const GMAIL_PROFILE_URL =
  "https://www.googleapis.com/gmail/v1/users/me/profile";

interface GmailUserInfo {
  id: string;
  email: string | null;
  name: string | null;
}

interface GmailTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: GmailUserInfo;
}

/**
 * Build Gmail OAuth authorization URL.
 * Requests offline access to obtain a refresh token.
 */
export function buildGmailAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("gmail");
  if (!oauthConfig) {
    throw new Error("Gmail OAuth config not found");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: oauthConfig.scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Google returns user info from a separate userinfo endpoint.
 */
export async function exchangeGmailCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<GmailTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("gmail");
  if (!oauthConfig) {
    throw new Error("Gmail OAuth config not found");
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
    throw new Error(`Gmail token exchange failed: ${response.status}`);
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
    throw new Error("No access token in Gmail response");
  }

  const userInfo = await fetchGmailUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Fetch Gmail user info using the Gmail API profile endpoint.
 * Uses the https://mail.google.com/ scope which is already requested.
 */
async function fetchGmailUserInfo(accessToken: string): Promise<GmailUserInfo> {
  const response = await fetch(GMAIL_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Gmail user info fetch failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    emailAddress?: string | null;
    messagesTotal?: number;
    threadsTotal?: number;
    historyId?: string;
  };

  return {
    id: data.emailAddress ?? "",
    email: data.emailAddress ?? null,
    name: data.emailAddress ?? null,
  };
}

/**
 * Get the primary secret name for Gmail connector (the access token).
 */
export function getGmailSecretName(): string {
  return "GMAIL_ACCESS_TOKEN";
}
