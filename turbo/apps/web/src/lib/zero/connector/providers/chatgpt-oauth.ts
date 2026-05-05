import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_OAUTH_ISSUER = "https://auth.openai.com";
export const CHATGPT_OAUTH_SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";

const TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token`;
const AUTHORIZE_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/authorize`;
const REVOKE_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/revoke`;

export type ChatgptRefreshErrorCode =
  | "refresh_token_expired"
  | "refresh_token_reused"
  | "refresh_token_invalidated"
  | "refresh_token_other";

/**
 * Typed error for refresh-token failures so the firewall pipeline can
 * distinguish stale-token cases (must re-OAuth) from transient HTTP errors
 * (retry next time).
 */
export interface ChatgptRefreshError extends Error {
  readonly name: "ChatgptRefreshError";
  readonly code: ChatgptRefreshErrorCode;
}

function createChatgptRefreshError(
  code: ChatgptRefreshErrorCode,
  message: string,
): ChatgptRefreshError {
  const err = new Error(message);
  err.name = "ChatgptRefreshError";
  Object.assign(err, { code });
  return err as ChatgptRefreshError;
}

export function isChatgptRefreshError(
  value: unknown,
): value is ChatgptRefreshError {
  return (
    value instanceof Error &&
    value.name === "ChatgptRefreshError" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

interface ChatgptExchangeResult {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  planType: string;
  workspaceName: string | null;
  expiresIn: number;
  scopes: string[];
}

interface ChatgptRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Skip JWT signature verification: the response is over TLS to auth.openai.com
// from a request we initiated, and the access_token is the auth-bearing artifact
// validated server-side by the ChatGPT backend. Codex's official client also
// does not verify locally.
function decodeJwtPayload(token: string): unknown {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) {
    throw new Error("Invalid JWT structure");
  }
  const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const json = Buffer.from(padded + padding, "base64").toString("utf-8");
  return JSON.parse(json);
}

const chatgptAuthClaimsSchema = z
  .object({
    chatgpt_account_id: z.string().optional(),
    chatgpt_plan_type: z.string().optional(),
    organization: z
      .object({ title: z.string().optional() })
      .partial()
      .optional(),
    workspace: z.object({ name: z.string().optional() }).partial().optional(),
    chatgpt_workspace_name: z.string().optional(),
  })
  .passthrough();

const chatgptIdTokenClaimsSchema = z
  .object({
    exp: z.number().optional(),
    "https://api.openai.com/auth": chatgptAuthClaimsSchema.optional(),
  })
  .passthrough();

type ChatgptAuthClaims = z.infer<typeof chatgptAuthClaimsSchema>;

function extractWorkspaceName(authClaims: ChatgptAuthClaims): string | null {
  return (
    authClaims.organization?.title ??
    authClaims.workspace?.name ??
    authClaims.chatgpt_workspace_name ??
    null
  );
}

const exchangeResponseSchema = z.object({
  id_token: z.string().optional(),
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

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

/**
 * Build the ChatGPT OAuth authorize URL with PKCE (S256).
 * The clientId parameter from the ProviderHandler interface is ignored —
 * ChatGPT's OAuth uses the public Codex client_id.
 */
export async function buildChatgptAuthorizationUrl(
  _clientId: string,
  redirectUri: string,
  state: string,
): Promise<{ url: string; codeVerifier: string }> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CHATGPT_OAUTH_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
  });

  return {
    url: `${AUTHORIZE_URL}?${params.toString()}`,
    codeVerifier,
  };
}

/**
 * Exchange an authorization code for ChatGPT tokens via PKCE.
 * Decodes the id_token to extract account_id, plan_type, and workspace name.
 * Rejects free-plan accounts.
 */
export async function exchangeChatgptCode(
  _clientId: string,
  _clientSecret: string,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<ChatgptExchangeResult> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("ChatGPT", "exchange", response);
  }

  const data = exchangeResponseSchema.parse(await response.json());
  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }
  if (!data.access_token || !data.refresh_token || !data.id_token) {
    throw new Error("ChatGPT exchange response missing tokens");
  }

  const claims = chatgptIdTokenClaimsSchema.parse(
    decodeJwtPayload(data.id_token),
  );
  const auth = claims["https://api.openai.com/auth"];
  if (!auth?.chatgpt_account_id || !auth.chatgpt_plan_type) {
    throw new Error("ChatGPT id_token missing required auth claims");
  }
  if (auth.chatgpt_plan_type === "free") {
    throw new Error(
      "ChatGPT free plan is not supported — upgrade to Plus, Pro, Business, Edu, or Enterprise",
    );
  }

  const expiresIn =
    data.expires_in ??
    (claims.exp ? claims.exp - Math.floor(Date.now() / 1000) : 0);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    accountId: auth.chatgpt_account_id,
    planType: auth.chatgpt_plan_type,
    workspaceName: extractWorkspaceName(auth),
    expiresIn,
    scopes: data.scope
      ? data.scope.split(" ")
      : CHATGPT_OAUTH_SCOPES.split(" "),
  };
}

/**
 * Refresh a ChatGPT access token. Refresh tokens rotate on each call —
 * the new refresh_token (when present) is returned and must be persisted by
 * the caller. 401 responses are classified into ChatgptRefreshError codes
 * so the firewall pipeline can distinguish stale-token from transient errors.
 */
export async function refreshChatgptToken(
  _clientId: string,
  _clientSecret: string,
  refreshToken: string,
): Promise<ChatgptRefreshResult> {
  const response = await fetch(TOKEN_URL, {
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
    let code: ChatgptRefreshErrorCode = "refresh_token_other";
    let message = body;
    try {
      const parsed = refreshErrorBodySchema.parse(JSON.parse(body));
      const errCode = parsed.error?.code;
      if (
        errCode === "refresh_token_expired" ||
        errCode === "refresh_token_reused" ||
        errCode === "refresh_token_invalidated"
      ) {
        code = errCode;
      }
      message = parsed.error?.message ?? body;
    } catch {
      // body wasn't JSON — keep raw text as message, code stays "refresh_token_other"
    }
    throw createChatgptRefreshError(code, `ChatGPT refresh failed: ${message}`);
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

/**
 * Revoke a ChatGPT access token (used on user-initiated disconnect).
 */
export async function revokeChatgptToken(
  _clientId: string,
  _clientSecret: string,
  accessToken: string,
): Promise<void> {
  const response = await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: accessToken }),
  });
  if (!response.ok) {
    await throwOAuthError("ChatGPT", "revoke", response);
  }
}

export function getChatgptSecretName(): string {
  return "CHATGPT_ACCESS_TOKEN";
}

export function getChatgptRefreshSecretName(): string {
  return "CHATGPT_REFRESH_TOKEN";
}
