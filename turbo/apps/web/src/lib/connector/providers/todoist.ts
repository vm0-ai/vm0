import { getConnectorOAuthConfig } from "@vm0/core";
import { z } from "zod";

const TODOIST_SYNC_URL = "https://api.todoist.com/sync/v9/sync";

interface TodoistTokenResult {
  accessToken: string;
  scopes: string[];
  userInfo: {
    id: string;
    username: string | null;
    email: string | null;
  };
}

/**
 * Build Todoist OAuth authorization URL.
 * Todoist uses comma-separated scopes.
 */
export function buildTodoistAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("todoist");
  if (!oauthConfig) {
    throw new Error("Todoist OAuth config not found");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    scope: oauthConfig.scopes.join(","),
    state,
    redirect_uri: redirectUri,
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token.
 * Todoist tokens are long-lived — no refresh token is returned.
 * User info is fetched separately via the Sync API.
 */
export async function exchangeTodoistCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<TodoistTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("todoist");
  if (!oauthConfig) {
    throw new Error("Todoist OAuth config not found");
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
    }),
  });

  if (!response.ok) {
    throw new Error(`Todoist token exchange failed: ${response.status}`);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      token_type: z.string().optional(),
      error: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(`Todoist OAuth error: ${data.error}`);
  }

  if (!data.access_token) {
    throw new Error("No access token in Todoist response");
  }

  const userInfo = await fetchTodoistUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    scopes: oauthConfig.scopes,
    userInfo,
  };
}

/**
 * Fetch user info from Todoist Sync API.
 */
async function fetchTodoistUserInfo(accessToken: string): Promise<{
  id: string;
  username: string | null;
  email: string | null;
}> {
  const response = await fetch(TODOIST_SYNC_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      sync_token: "*",
      resource_types: '["user"]',
    }),
  });

  if (!response.ok) {
    throw new Error(`Todoist user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      user: z
        .object({
          id: z.number().optional(),
          full_name: z.string().nullable().optional(),
          email: z.string().nullable().optional(),
        })
        .optional(),
    })
    .parse(await response.json());

  return {
    id: data.user?.id?.toString() ?? "",
    username: data.user?.full_name ?? null,
    email: data.user?.email ?? null,
  };
}

/**
 * Get the primary secret name for Todoist connector (the access token).
 */
export function getTodoistSecretName(): string {
  return "TODOIST_ACCESS_TOKEN";
}
