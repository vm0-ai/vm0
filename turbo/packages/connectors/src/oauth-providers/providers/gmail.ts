import { getConnectorOAuthConfig } from "@vm0/connectors/connector-utils";
import { z } from "zod";
import { buildGoogleAuthorizationUrl } from "./google-oauth";
import { throwOAuthError } from "./oauth-error";

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
  return buildGoogleAuthorizationUrl("gmail", clientId, redirectUri, state);
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
    await throwOAuthError("Gmail", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().optional(),
      scope: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

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

  const data = z
    .object({
      emailAddress: z.string().nullable().optional(),
      messagesTotal: z.number().optional(),
      threadsTotal: z.number().optional(),
      historyId: z.string().optional(),
    })
    .parse(await response.json());

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
