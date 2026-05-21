import { getOAuthConnectorConfig } from "@vm0/connectors/connector-utils";
import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

const POSTHOG_USER_INFO_URL = "https://us.posthog.com/api/users/@me/";

interface PosthogUserInfo {
  id: string;
  name: string | null;
  email: string | null;
}

interface PosthogTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: PosthogUserInfo;
}

interface PosthogRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

/**
 * Build PostHog OAuth authorization URL.
 */
export function buildPosthogAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getOAuthConnectorConfig("posthog");
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
 */
export async function exchangePosthogCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<PosthogTokenResult> {
  const oauthConfig = getOAuthConnectorConfig("posthog");
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
    await throwOAuthError("PostHog", "exchange", response);
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
    throw new Error("No access token in PostHog response");
  }

  const userInfo = await fetchPosthogUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Refresh a PostHog access token using the refresh token.
 * Access token expires_in: 36000s (10 hours). Ref: https://posthog.com/handbook/engineering/oauth-development-guide
 */
export async function refreshPosthogToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<PosthogRefreshResult> {
  const oauthConfig = getOAuthConnectorConfig("posthog");
  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("PostHog", "refresh", response);
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
    throw new Error("No access token in PostHog refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Fetch PostHog user info using the REST API.
 */
async function fetchPosthogUserInfo(
  accessToken: string,
): Promise<PosthogUserInfo> {
  const response = await fetch(POSTHOG_USER_INFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`PostHog user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.number(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string().optional(),
    })
    .parse(await response.json());

  const name = [data.first_name, data.last_name].filter(Boolean).join(" ");

  return {
    id: String(data.id),
    name: name || null,
    email: data.email ?? null,
  };
}

/**
 * Get the primary secret name for PostHog connector (the access token).
 */
export function getPosthogSecretName(): string {
  return "POSTHOG_ACCESS_TOKEN";
}
