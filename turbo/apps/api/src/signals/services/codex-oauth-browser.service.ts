import { z } from "zod";
import {
  CHATGPT_OAUTH_AUTHORIZATION_URL,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_SCOPES,
  CHATGPT_OAUTH_TOKEN_URL,
} from "@vm0/connectors/oauth-providers/providers/codex-oauth";

import { now } from "../../lib/time";
import { safeJsonParse } from "../utils";

interface ChatgptOAuthResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accountId: string;
  readonly idToken: string;
  readonly expiresIn?: number;
  readonly tokenExpiresAt: Date;
  readonly workspaceName: string | null;
  readonly planType: string;
  readonly userInfo: {
    readonly id: string;
    readonly username: string | null;
    readonly email: string | null;
  };
}

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

type ChatgptAuthClaims = z.infer<typeof chatgptAuthClaimsSchema>;

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
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

function decodeJwtPayload(token: string): unknown | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) {
    return undefined;
  }
  const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return safeJsonParse(
    Buffer.from(padded + padding, "base64").toString("utf8"),
  );
}

function readJwtExp(token: string): number | null {
  const parsed = expSchema.safeParse(decodeJwtPayload(token));
  return parsed.success ? parsed.data.exp : null;
}

function extractWorkspaceName(authClaims: ChatgptAuthClaims): string | null {
  return (
    authClaims.organization?.title ??
    authClaims.workspace?.name ??
    authClaims.chatgpt_workspace_name ??
    null
  );
}

function parseChatgptOAuthResult(data: {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
  readonly expiresIn?: number;
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
    (data.expiresIn ? Math.floor(now() / 1000) + data.expiresIn : null);
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

export function getChatgptOAuthClientId(): string {
  return CHATGPT_OAUTH_CLIENT_ID;
}

export async function buildChatgptAuthorizationUrl(args: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
}): Promise<{ readonly url: string; readonly codeVerifier: string }> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    scope: CHATGPT_OAUTH_SCOPES.join(" "),
    state: args.state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    url: `${CHATGPT_OAUTH_AUTHORIZATION_URL}?${params.toString()}`,
    codeVerifier,
  };
}

export async function exchangeChatgptCode(args: {
  readonly clientId: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}): Promise<ChatgptOAuthResult> {
  const response = await fetch(CHATGPT_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: args.clientId,
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      code_verifier: args.codeVerifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`ChatGPT exchange failed: ${await response.text()}`);
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
