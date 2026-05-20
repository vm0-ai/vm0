import { getConnectorOAuthConfig } from "@vm0/connectors/connector-utils";
import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

const BASE44_REGISTER_URL = "https://app.base44.com/oauth/register";
const BASE44_USERINFO_URL = "https://app.base44.com/oauth/userinfo";
const BASE44_CONTEXT_VERSION = 1;
const BASE44_REFRESH_CREDENTIAL_VERSION = 1;

interface Base44UserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface Base44TokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: Base44UserInfo;
}

interface Base44RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

const base44ContextSchema = z.object({
  version: z.literal(BASE44_CONTEXT_VERSION),
  clientId: z.string().min(1),
});

const base44RefreshCredentialSchema = z.object({
  version: z.literal(BASE44_REFRESH_CREDENTIAL_VERSION),
  clientId: z.string().min(1),
  refreshToken: z.string().min(1),
});

function base64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseBase64UrlJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function encodeOAuthContext(clientId: string): string {
  return base64UrlJson({
    version: BASE44_CONTEXT_VERSION,
    clientId,
  });
}

function decodeOAuthContext(oauthContext: string | undefined): string {
  if (!oauthContext) {
    throw new Error("Base44 OAuth context is missing");
  }
  return base44ContextSchema.parse(parseBase64UrlJson(oauthContext)).clientId;
}

function encodeRefreshCredential(args: {
  readonly clientId: string;
  readonly refreshToken: string;
}): string {
  return base64UrlJson({
    version: BASE44_REFRESH_CREDENTIAL_VERSION,
    clientId: args.clientId,
    refreshToken: args.refreshToken,
  });
}

function decodeRefreshCredential(refreshToken: string): {
  readonly clientId: string;
  readonly refreshToken: string;
} {
  const parsed = base44RefreshCredentialSchema.parse(
    parseBase64UrlJson(refreshToken),
  );
  return {
    clientId: parsed.clientId,
    refreshToken: parsed.refreshToken,
  };
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

function getBase44OAuthConfig() {
  const oauthConfig = getConnectorOAuthConfig("base44");
  if (!oauthConfig?.authorizationUrl) {
    throw new Error("Base44 OAuth config not found");
  }
  return oauthConfig;
}

async function registerBase44Client(args: {
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}): Promise<string> {
  const response = await fetch(BASE44_REGISTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_name: "vm0",
      redirect_uris: [args.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: args.scopes.join(" "),
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Base44", "registration", response);
  }

  const data = z
    .object({
      client_id: z.string().min(1),
    })
    .parse(await response.json());
  return data.client_id;
}

export async function buildBase44AuthorizationUrl(args: {
  readonly redirectUri: string;
  readonly state: string;
}): Promise<{
  readonly url: string;
  readonly codeVerifier: string;
  readonly oauthContext: string;
}> {
  const oauthConfig = getBase44OAuthConfig();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);
  const clientId = await registerBase44Client({
    redirectUri: args.redirectUri,
    scopes: oauthConfig.scopes,
  });

  const params = new URLSearchParams({
    client_id: clientId,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: args.redirectUri,
    response_type: "code",
    scope: oauthConfig.scopes.join(" "),
    state: args.state,
  });

  return {
    url: `${oauthConfig.authorizationUrl}?${params.toString()}`,
    codeVerifier,
    oauthContext: encodeOAuthContext(clientId),
  };
}

export async function exchangeBase44Code(args: {
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
}): Promise<Base44TokenResult> {
  const oauthConfig = getBase44OAuthConfig();
  const clientId = decodeOAuthContext(args.oauthContext);
  if (!args.codeVerifier) {
    throw new Error("Base44 requires PKCE code_verifier for token exchange");
  }

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      code: args.code,
      code_verifier: args.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: args.redirectUri,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Base44", "exchange", response);
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
    throw new Error("No access token in Base44 response");
  }
  if (!data.refresh_token) {
    throw new Error("No refresh token in Base44 response");
  }

  const userInfo = await fetchBase44UserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: encodeRefreshCredential({
      clientId,
      refreshToken: data.refresh_token,
    }),
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : oauthConfig.scopes,
    userInfo,
  };
}

async function fetchBase44UserInfo(
  accessToken: string,
): Promise<Base44UserInfo> {
  const response = await fetch(BASE44_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    await throwOAuthError("Base44", "userinfo", response);
  }

  const data = z
    .object({
      sub: z.string().optional(),
      id: z.string().optional(),
      name: z.string().nullable().optional(),
      username: z.string().nullable().optional(),
      preferred_username: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .parse(await response.json());
  const id = data.sub ?? data.id;
  if (!id) {
    throw new Error("No user id in Base44 userinfo response");
  }

  return {
    id,
    username: data.name ?? data.username ?? data.preferred_username ?? null,
    email: data.email ?? null,
  };
}

export async function refreshBase44Token(
  refreshCredential: string,
): Promise<Base44RefreshResult> {
  const oauthConfig = getBase44OAuthConfig();
  const decoded = decodeRefreshCredential(refreshCredential);
  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: decoded.clientId,
      grant_type: "refresh_token",
      refresh_token: decoded.refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Base44", "refresh", response);
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
    throw new Error("No access token in Base44 refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: encodeRefreshCredential({
      clientId: decoded.clientId,
      refreshToken: data.refresh_token ?? decoded.refreshToken,
    }),
    expiresIn: data.expires_in,
  };
}

export function getBase44SecretName(): string {
  return "BASE44_ACCESS_TOKEN";
}

export function getBase44RefreshSecretName(): string {
  return "BASE44_REFRESH_TOKEN";
}
