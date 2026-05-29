import { z } from "zod";
import {
  createOAuthProviderError,
  isOAuthProviderError,
  throwOAuthError,
  type OAuthProviderError,
} from "../error";

export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_OAUTH_ISSUER = "https://auth.openai.com";

const CHATGPT_OAUTH_TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token`;

export type ChatgptRefreshErrorCode =
  | "refresh_token_expired"
  | "refresh_token_reused"
  | "refresh_token_invalidated"
  | "refresh_token_other";

/**
 * Typed error for refresh-token failures so the firewall pipeline can
 * distinguish stale-token cases (must re-auth) from transient HTTP errors
 * (retry next time).
 */
export interface ChatgptRefreshError extends OAuthProviderError {
  readonly code: ChatgptRefreshErrorCode;
  readonly refreshErrorCode: ChatgptRefreshErrorCode;
}

function isReconnectRequiredChatgptRefreshError(
  code: ChatgptRefreshErrorCode,
): boolean {
  return (
    code === "refresh_token_expired" ||
    code === "refresh_token_reused" ||
    code === "refresh_token_invalidated"
  );
}

function createChatgptRefreshError(
  code: ChatgptRefreshErrorCode,
  message: string,
): ChatgptRefreshError {
  const err = createOAuthProviderError({
    provider: "ChatGPT",
    operation: "refresh",
    message,
    failureClass: isReconnectRequiredChatgptRefreshError(code)
      ? "reconnect_required"
      : "provider_auth_rejected",
    upstreamStatus: 401,
    oauthError: code,
    refreshErrorCode: code,
  });
  Object.assign(err, { code });
  return err as ChatgptRefreshError;
}

export function isChatgptRefreshError(
  value: unknown,
): value is ChatgptRefreshError {
  return (
    isOAuthProviderError(value) &&
    value.provider === "ChatGPT" &&
    value.operation === "refresh" &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof value.refreshErrorCode === "string"
  );
}

interface ChatgptRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

const refreshResponseSchema = z.object({
  id_token: z.string().optional(),
  access_token: z.string().optional(),
  refresh_token: z.string().nullable().optional(),
  expires_in: z.number().optional(),
});

const refreshErrorBodySchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

const standardOAuthErrorBodySchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

function parseChatgptRefreshErrorBody(
  body: string,
): { readonly code: ChatgptRefreshErrorCode; readonly message: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { code: "refresh_token_other", message: body };
  }

  const standard = standardOAuthErrorBodySchema.safeParse(json);
  if (standard.success && standard.data.error) {
    return null;
  }

  const parsed = refreshErrorBodySchema.safeParse(json);
  if (!parsed.success) {
    return { code: "refresh_token_other", message: body };
  }

  const errCode = parsed.data.error?.code;
  const code =
    errCode === "refresh_token_expired" ||
    errCode === "refresh_token_reused" ||
    errCode === "refresh_token_invalidated"
      ? errCode
      : "refresh_token_other";
  return { code, message: parsed.data.error?.message ?? body };
}

/**
 * Refresh a ChatGPT access token. Refresh tokens rotate on each call -
 * the new refresh_token (when present) is returned and must be persisted by
 * the caller. 401 responses are classified into shared OAuthProviderError
 * failures with ChatGPT refresh codes attached.
 */
export async function refreshChatgptToken(
  _clientId: string,
  _clientSecret: string,
  refreshToken: string,
): Promise<ChatgptRefreshResult> {
  const response = await fetch(CHATGPT_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (response.status === 401) {
    const body = await response.text();
    const chatgptError = parseChatgptRefreshErrorBody(body);
    if (!chatgptError) {
      return await throwOAuthError(
        "ChatGPT",
        "refresh",
        new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      );
    }
    throw createChatgptRefreshError(
      chatgptError.code,
      `ChatGPT refresh failed: ${chatgptError.message}`,
    );
  }

  if (!response.ok) {
    await throwOAuthError("ChatGPT", "refresh", response);
  }

  const data = refreshResponseSchema.parse(await response.json());
  if (!data.access_token) {
    throw new Error("No access token in ChatGPT refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
  };
}

export function getChatgptSecretName(): string {
  return "CHATGPT_ACCESS_TOKEN";
}

export function getChatgptRefreshSecretName(): string {
  return "CHATGPT_REFRESH_TOKEN";
}
