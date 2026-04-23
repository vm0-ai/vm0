import { getConnectorOAuthConfig } from "@vm0/core/contracts/connector-utils";
import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

interface MondayUserInfo {
  id: string;
  username: string;
  email: string | null;
}

interface MondayTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: MondayUserInfo;
}

interface MondayRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

const MONDAY_GRAPHQL_URL = "https://api.monday.com/v2";

/**
 * Build Monday.com OAuth authorization URL.
 */
export function buildMondayAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("monday");
  if (!oauthConfig) {
    throw new Error("Monday.com OAuth config not found");
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
 * Monday.com returns user info via GraphQL after token exchange.
 */
export async function exchangeMondayCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<MondayTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("monday");
  if (!oauthConfig) {
    throw new Error("Monday.com OAuth config not found");
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
    await throwOAuthError("Monday.com", "exchange", response);
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
    throw new Error("No access token in Monday.com response");
  }

  const userInfo = await fetchMondayUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Refresh a Monday.com access token.
 * Note: Monday.com tokens reportedly do not expire. expires_in may not be returned. Ref: https://developer.monday.com/apps/docs/oauth
 */
export async function refreshMondayToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<MondayRefreshResult> {
  const oauthConfig = getConnectorOAuthConfig("monday");
  if (!oauthConfig) {
    throw new Error("Monday.com OAuth config not found");
  }

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
    await throwOAuthError("Monday.com", "refresh", response);
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
    throw new Error("No access token in Monday.com refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Fetch Monday.com user info via GraphQL.
 */
async function fetchMondayUserInfo(
  accessToken: string,
): Promise<MondayUserInfo> {
  const response = await fetch(MONDAY_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "API-Version": "2024-01",
    },
    body: JSON.stringify({
      query: "{ me { id name email } }",
    }),
  });

  if (!response.ok) {
    throw new Error(`Monday.com user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      data: z
        .object({
          me: z
            .object({
              id: z.union([z.string(), z.number()]).optional(),
              name: z.string().nullable().optional(),
              email: z.string().nullable().optional(),
            })
            .optional(),
        })
        .optional(),
      errors: z.array(z.object({ message: z.string() })).optional(),
    })
    .parse(await response.json());

  if (data.errors?.length) {
    throw new Error(data.errors[0]?.message ?? "Unknown GraphQL error");
  }

  const me = data.data?.me;
  if (!me?.id) {
    throw new Error("No user data in Monday.com response");
  }

  return {
    id: String(me.id),
    username: me.name ?? "",
    email: me.email ?? null,
  };
}

/**
 * Get the primary secret name for Monday.com connector.
 */
export function getMondaySecretName(): string {
  return "MONDAY_ACCESS_TOKEN";
}
