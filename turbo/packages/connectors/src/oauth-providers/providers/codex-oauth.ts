import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_OAUTH_ISSUER = "https://auth.openai.com";

export const CHATGPT_OAUTH_AUTHORIZATION_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/authorize`;
export const CHATGPT_OAUTH_TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token`;
export const CHATGPT_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "api.connectors.read",
  "api.connectors.invoke",
] as const;

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

interface ChatgptRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

interface ChatgptOAuthResult {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  idToken: string;
  expiresIn?: number;
  tokenExpiresAt: Date;
  workspaceName: string | null;
  planType: string;
  userInfo: { id: string; username: string | null; email: string | null };
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

const tokenResponseSchema = z.object({
  id_token: z.string().optional(),
  access_token: z.string().optional(),
  refresh_token: z.string().nullable().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

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
    sub: z.string().optional(),
    email: z.string().optional(),
    name: z.string().optional(),
    exp: z.number().optional(),
    "https://api.openai.com/auth": chatgptAuthClaimsSchema.optional(),
  })
  .passthrough();

const expSchema = z.object({ exp: z.number() }).passthrough();

function base64UrlEncode(bytes: Uint8Array): string {
  const binString = Array.from(bytes, (b) => {
    return String.fromCharCode(b);
  }).join("");
  return btoa(binString)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

function decodeJwtPayload(token: string): unknown {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) {
    throw new Error("Invalid JWT structure");
  }
  const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return JSON.parse(Buffer.from(padded + padding, "base64").toString("utf-8"));
}

function readJwtExp(token: string): number | null {
  try {
    const parsed = expSchema.safeParse(decodeJwtPayload(token));
    return parsed.success ? parsed.data.exp : null;
  } catch {
    return null;
  }
}

function extractWorkspaceName(
  authClaims: z.infer<typeof chatgptAuthClaimsSchema>,
): string | null {
  return (
    authClaims.organization?.title ??
    authClaims.workspace?.name ??
    authClaims.chatgpt_workspace_name ??
    null
  );
}

function parseChatgptOAuthResult(data: {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn?: number;
}): ChatgptOAuthResult {
  const idClaims = chatgptIdTokenClaimsSchema.parse(
    decodeJwtPayload(data.idToken),
  );
  const auth = idClaims["https://api.openai.com/auth"];
  if (!auth?.chatgpt_account_id || !auth.chatgpt_plan_type) {
    throw new Error("OpenAI id_token missing required ChatGPT claims");
  }
  if (auth.chatgpt_plan_type === "free") {
    throw new Error(
      "ChatGPT free plan is not supported - upgrade to Plus or higher.",
    );
  }

  const exp =
    readJwtExp(data.accessToken) ??
    idClaims.exp ??
    (data.expiresIn ? Math.floor(Date.now() / 1000) + data.expiresIn : null);
  if (exp === null) {
    throw new Error("OpenAI access token has no expiry");
  }

  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    accountId: auth.chatgpt_account_id,
    idToken: data.idToken,
    expiresIn: data.expiresIn,
    tokenExpiresAt: new Date(exp * 1000),
    workspaceName: extractWorkspaceName(auth),
    planType: auth.chatgpt_plan_type,
    userInfo: {
      id: auth.chatgpt_account_id,
      username: idClaims.name ?? null,
      email: idClaims.email ?? null,
    },
  };
}

export async function buildChatgptAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): Promise<{ url: string; codeVerifier: string }> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: CHATGPT_OAUTH_SCOPES.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    url: `${CHATGPT_OAUTH_AUTHORIZATION_URL}?${params.toString()}`,
    codeVerifier,
  };
}

export async function exchangeChatgptCode(
  clientId: string,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<ChatgptOAuthResult> {
  const response = await fetch(CHATGPT_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("ChatGPT", "exchange", response);
  }

  const parsed = tokenResponseSchema.parse(await response.json());
  if (parsed.error) {
    throw new Error(parsed.error_description ?? parsed.error);
  }
  if (!parsed.access_token || !parsed.refresh_token || !parsed.id_token) {
    throw new Error("OpenAI OAuth response missing required tokens");
  }

  return parseChatgptOAuthResult({
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    idToken: parsed.id_token,
    expiresIn: parsed.expires_in,
  });
}

/**
 * Refresh a ChatGPT access token. Refresh tokens rotate on each call -
 * the new refresh_token (when present) is returned and must be persisted by
 * the caller. 401 responses are classified into ChatgptRefreshError codes
 * so the firewall pipeline can distinguish stale-token from transient errors.
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
      // body wasn't JSON - keep raw text as message, code stays "refresh_token_other"
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

export function getChatgptSecretName(): string {
  return "CHATGPT_ACCESS_TOKEN";
}

export function getChatgptRefreshSecretName(): string {
  return "CHATGPT_REFRESH_TOKEN";
}
