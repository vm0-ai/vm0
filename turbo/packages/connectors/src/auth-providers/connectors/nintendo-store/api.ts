import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import type { ConnectorExternalCodeGrantConfig } from "@vm0/connectors/connectors";
import type { ConnectorAuthProviderGrantUserInfo } from "../../grant-result";
import { OAuthProviderHttpError, throwOAuthError } from "../../oauth/error";

export const NINTENDO_STORE_AUTHORIZATION_URL =
  "https://accounts.nintendo.com/connect/1.0.0/authorize";
export const NINTENDO_STORE_SESSION_TOKEN_URL =
  "https://accounts.nintendo.com/connect/1.0.0/api/session_token";
export const NINTENDO_STORE_TOKEN_URL =
  "https://accounts.nintendo.com/connect/1.0.0/api/token";
export const NINTENDO_STORE_PROFILE_URL =
  "https://api.accounts.nintendo.com/2.0.0/users/me";
export const NINTENDO_STORE_REDIRECT_URI = "npf5c38e31cd085304b://auth";
export const NINTENDO_STORE_USER_AGENT =
  "com.nintendo.znej/1.13.0 (Android/7.1.2)";

const NINTENDO_SESSION_TOKEN_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:jwt-bearer-session-token";

export interface NintendoStoreProviderState {
  readonly version: 1;
  readonly state: string;
  readonly codeVerifier: string;
}

export interface NintendoStoreSessionToken {
  readonly sessionToken: string;
}

export interface NintendoStoreToken {
  readonly accessToken: string;
  readonly expiresIn?: number;
  readonly idToken: string;
  readonly scopes: readonly string[];
  readonly tokenType: string;
}

interface NintendoStoreIdentity {
  readonly accountId: string;
  readonly username: string | null;
  readonly email: string | null;
}

export interface NintendoStoreLocale {
  readonly country: string;
  readonly language: string;
  readonly locale: string;
}

const nintendoStoreSessionTokenSchema = z
  .object({
    session_token: z.string().min(1),
  })
  .passthrough();

const nintendoStoreTokenSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().optional(),
    id_token: z.string().min(1),
    scope: z.union([z.string(), z.array(z.string())]).optional(),
    token_type: z.string().optional(),
  })
  .passthrough();

const nintendoStoreIdTokenClaimsSchema = z
  .object({
    sub: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    preferred_username: z.string().min(1).optional(),
  })
  .passthrough();

const nintendoStoreProfileSchema = z
  .object({
    country: z.string().min(1),
    language: z.string().min(1),
  })
  .passthrough();

function base64UrlRandom(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function createNintendoStoreProviderState(): NintendoStoreProviderState {
  return {
    version: 1,
    state: base64UrlRandom(36),
    codeVerifier: base64UrlRandom(32),
  };
}

export function buildNintendoStoreAuthorizationUrl(args: {
  readonly clientId: string;
  readonly grant: ConnectorExternalCodeGrantConfig;
  readonly providerState: NintendoStoreProviderState;
}): string {
  const params = new URLSearchParams({
    state: args.providerState.state,
    client_id: args.clientId,
    redirect_uri: NINTENDO_STORE_REDIRECT_URI,
    scope: args.grant.scopes.join(" "),
    response_type: "session_token_code",
    session_token_code_challenge: sha256Base64Url(
      args.providerState.codeVerifier,
    ),
    session_token_code_challenge_method: "S256",
    theme: "login_form",
  });

  return `${NINTENDO_STORE_AUTHORIZATION_URL}?${params.toString()}`;
}

function invalidNintendoExternalCodeError(
  message: string,
): OAuthProviderHttpError {
  return new OAuthProviderHttpError(message, 400, "invalid_grant");
}

function hasAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function parseParamsFromInput(input: string): URLSearchParams | null {
  if (input.startsWith("#")) {
    return new URLSearchParams(input.slice(1));
  }
  if (input.startsWith("?")) {
    return new URLSearchParams(input.slice(1));
  }
  if (input.includes("://")) {
    try {
      const parsed = new URL(input);
      const fragmentParams = new URLSearchParams(parsed.hash.slice(1));
      if (fragmentParams.toString().length > 0) {
        return fragmentParams;
      }
      return parsed.searchParams;
    } catch {
      return new URLSearchParams();
    }
  }
  if (input.includes("session_token_code=")) {
    try {
      const parsed = new URL(input);
      const fragmentParams = new URLSearchParams(parsed.hash.slice(1));
      if (fragmentParams.has("session_token_code")) {
        return fragmentParams;
      }
      return parsed.searchParams;
    } catch {
      return new URLSearchParams(input.replace(/^#/u, "").replace(/^\?/u, ""));
    }
  }
  return null;
}

export function parseNintendoStoreSessionTokenCode(args: {
  readonly code: string;
  readonly expectedState: string;
}): string {
  const trimmed = args.code.trim();
  if (!trimmed || hasAsciiControl(trimmed)) {
    throw invalidNintendoExternalCodeError(
      "Nintendo Store authorization code is empty or invalid",
    );
  }

  const params = parseParamsFromInput(trimmed);
  if (!params) {
    return trimmed;
  }

  const state = params.get("state");
  if (state !== null && state !== args.expectedState) {
    throw invalidNintendoExternalCodeError(
      "Nintendo Store authorization state mismatch",
    );
  }

  const sessionTokenCode = params.get("session_token_code")?.trim();
  if (!sessionTokenCode || hasAsciiControl(sessionTokenCode)) {
    throw invalidNintendoExternalCodeError(
      "Nintendo Store redirect URL is missing session_token_code",
    );
  }
  return sessionTokenCode;
}

export async function exchangeNintendoStoreSessionTokenCode(args: {
  readonly clientId: string;
  readonly sessionTokenCode: string;
  readonly codeVerifier: string;
  readonly signal: AbortSignal;
}): Promise<NintendoStoreSessionToken> {
  const response = await fetch(NINTENDO_STORE_SESSION_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": NINTENDO_STORE_USER_AGENT,
      Accept: "application/json",
      "Accept-Language": "en-US",
    },
    body: new URLSearchParams({
      client_id: args.clientId,
      session_token_code: args.sessionTokenCode,
      session_token_code_verifier: args.codeVerifier,
    }),
    signal: args.signal,
  });

  if (!response.ok) {
    await throwOAuthError("Nintendo Store", "session exchange", response);
  }

  const raw = nintendoStoreSessionTokenSchema.parse(await response.json());
  return { sessionToken: raw.session_token };
}

function normalizeScopes(
  scope: string | readonly string[] | undefined,
): readonly string[] {
  if (typeof scope !== "string") {
    return scope ?? [];
  }
  return scope.split(/\s+/u).filter((value: string) => {
    return value.length > 0;
  });
}

export async function exchangeNintendoStoreSessionToken(args: {
  readonly clientId: string;
  readonly sessionToken: string;
  readonly signal: AbortSignal;
}): Promise<NintendoStoreToken> {
  const response = await fetch(NINTENDO_STORE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": NINTENDO_STORE_USER_AGENT,
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: args.clientId,
      session_token: args.sessionToken,
      grant_type: NINTENDO_SESSION_TOKEN_GRANT_TYPE,
    }),
    signal: args.signal,
  });

  if (!response.ok) {
    await throwOAuthError("Nintendo Store", "token exchange", response);
  }

  const raw = nintendoStoreTokenSchema.parse(await response.json());
  return {
    accessToken: raw.access_token,
    ...(raw.expires_in === undefined ? {} : { expiresIn: raw.expires_in }),
    idToken: raw.id_token,
    scopes: normalizeScopes(raw.scope),
    tokenType: raw.token_type ?? "Bearer",
  };
}

export async function fetchNintendoStoreLocale(args: {
  readonly accessToken: string;
  readonly signal: AbortSignal;
}): Promise<NintendoStoreLocale> {
  const response = await fetch(NINTENDO_STORE_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "User-Agent": NINTENDO_STORE_USER_AGENT,
      Accept: "application/json",
    },
    signal: args.signal,
  });

  if (!response.ok) {
    await throwOAuthError("Nintendo Store", "profile", response);
  }

  const raw = nintendoStoreProfileSchema.parse(await response.json());
  return {
    country: raw.country,
    language: raw.language,
    locale: `${raw.language}-${raw.country}`,
  };
}

function parseNintendoStoreIdentity(idToken: string): NintendoStoreIdentity {
  const [, payload] = idToken.split(".");
  if (!payload) {
    throw new Error("Nintendo Store ID token is missing a payload");
  }
  const rawClaims: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  );
  const claims = nintendoStoreIdTokenClaimsSchema.parse(rawClaims);
  if (!claims.sub) {
    throw new Error("Nintendo Store ID token is missing a subject");
  }
  return {
    accountId: claims.sub,
    username: claims.preferred_username ?? claims.name ?? null,
    email: claims.email ?? null,
  };
}

export function nintendoStoreUserInfo(
  idToken: string,
): ConnectorAuthProviderGrantUserInfo {
  const identity = parseNintendoStoreIdentity(idToken);
  return {
    id: identity.accountId,
    username: identity.username,
    email: identity.email,
  };
}

export function nintendoStoreAccountId(idToken: string): string {
  return parseNintendoStoreIdentity(idToken).accountId;
}
