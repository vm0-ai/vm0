import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import type { ConnectorExternalCodeGrantConfig } from "@vm0/connectors/connectors";
import type { ConnectorAuthProviderGrantUserInfo } from "../../grant-result";
import { OAuthProviderHttpError, throwOAuthError } from "../../oauth/error";

export const NINTENDO_PLAY_ACTIVITY_AUTHORIZATION_URL =
  "https://accounts.nintendo.com/connect/1.0.0/authorize";
export const NINTENDO_PLAY_ACTIVITY_SESSION_TOKEN_URL =
  "https://accounts.nintendo.com/connect/1.0.0/api/session_token";
export const NINTENDO_PLAY_ACTIVITY_TOKEN_URL =
  "https://accounts.nintendo.com/connect/1.0.0/api/token";
export const NINTENDO_PLAY_ACTIVITY_REDIRECT_URI = "npf5c38e31cd085304b://auth";
export const NINTENDO_PLAY_ACTIVITY_USER_AGENT =
  "com.nintendo.znej/1.13.0 (Android/7.1.2)";

const NINTENDO_SESSION_TOKEN_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:jwt-bearer-session-token";

export interface NintendoPlayActivityProviderState {
  readonly version: 1;
  readonly state: string;
  readonly codeVerifier: string;
}

export interface NintendoPlayActivitySessionToken {
  readonly sessionToken: string;
}

export interface NintendoPlayActivityToken {
  readonly accessToken: string;
  readonly expiresIn?: number;
  readonly idToken: string;
  readonly scopes: readonly string[];
  readonly tokenType: string;
}

interface NintendoPlayActivityIdentity {
  readonly accountId: string;
  readonly username: string | null;
  readonly email: string | null;
}

const nintendoPlayActivitySessionTokenSchema = z
  .object({
    session_token: z.string().min(1),
  })
  .passthrough();

const nintendoPlayActivityTokenSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().optional(),
    id_token: z.string().min(1),
    scope: z.union([z.string(), z.array(z.string())]).optional(),
    token_type: z.string().optional(),
  })
  .passthrough();

const nintendoPlayActivityIdTokenClaimsSchema = z
  .object({
    sub: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    preferred_username: z.string().min(1).optional(),
  })
  .passthrough();

function base64UrlRandom(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function createNintendoPlayActivityProviderState(): NintendoPlayActivityProviderState {
  return {
    version: 1,
    state: base64UrlRandom(36),
    codeVerifier: base64UrlRandom(32),
  };
}

export function buildNintendoPlayActivityAuthorizationUrl(args: {
  readonly clientId: string;
  readonly grant: ConnectorExternalCodeGrantConfig;
  readonly providerState: NintendoPlayActivityProviderState;
}): string {
  const params = new URLSearchParams({
    state: args.providerState.state,
    client_id: args.clientId,
    redirect_uri: NINTENDO_PLAY_ACTIVITY_REDIRECT_URI,
    scope: args.grant.scopes.join(" "),
    response_type: "session_token_code",
    session_token_code_challenge: sha256Base64Url(
      args.providerState.codeVerifier,
    ),
    session_token_code_challenge_method: "S256",
    theme: "login_form",
  });

  return `${NINTENDO_PLAY_ACTIVITY_AUTHORIZATION_URL}?${params.toString()}`;
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

export function parseNintendoPlayActivitySessionTokenCode(args: {
  readonly code: string;
  readonly expectedState: string;
}): string {
  const trimmed = args.code.trim();
  if (!trimmed || hasAsciiControl(trimmed)) {
    throw invalidNintendoExternalCodeError(
      "Nintendo Play Activity authorization code is empty or invalid",
    );
  }

  const params = parseParamsFromInput(trimmed);
  if (!params) {
    return trimmed;
  }

  const state = params.get("state");
  if (state !== null && state !== args.expectedState) {
    throw invalidNintendoExternalCodeError(
      "Nintendo Play Activity authorization state mismatch",
    );
  }

  const sessionTokenCode = params.get("session_token_code")?.trim();
  if (!sessionTokenCode || hasAsciiControl(sessionTokenCode)) {
    throw invalidNintendoExternalCodeError(
      "Nintendo Play Activity redirect URL is missing session_token_code",
    );
  }
  return sessionTokenCode;
}

export async function exchangeNintendoPlayActivitySessionTokenCode(args: {
  readonly clientId: string;
  readonly sessionTokenCode: string;
  readonly codeVerifier: string;
  readonly signal: AbortSignal;
}): Promise<NintendoPlayActivitySessionToken> {
  const response = await fetch(NINTENDO_PLAY_ACTIVITY_SESSION_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": NINTENDO_PLAY_ACTIVITY_USER_AGENT,
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
    await throwOAuthError(
      "Nintendo Play Activity",
      "session exchange",
      response,
    );
  }

  const raw = nintendoPlayActivitySessionTokenSchema.parse(
    await response.json(),
  );
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

export async function exchangeNintendoPlayActivitySessionToken(args: {
  readonly clientId: string;
  readonly sessionToken: string;
  readonly signal: AbortSignal;
}): Promise<NintendoPlayActivityToken> {
  const response = await fetch(NINTENDO_PLAY_ACTIVITY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": NINTENDO_PLAY_ACTIVITY_USER_AGENT,
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
    await throwOAuthError("Nintendo Play Activity", "token exchange", response);
  }

  const raw = nintendoPlayActivityTokenSchema.parse(await response.json());
  return {
    accessToken: raw.access_token,
    ...(raw.expires_in === undefined ? {} : { expiresIn: raw.expires_in }),
    idToken: raw.id_token,
    scopes: normalizeScopes(raw.scope),
    tokenType: raw.token_type ?? "Bearer",
  };
}

function parseNintendoPlayActivityIdentity(
  idToken: string,
): NintendoPlayActivityIdentity {
  const [, payload] = idToken.split(".");
  if (!payload) {
    throw new Error("Nintendo Play Activity ID token is missing a payload");
  }
  const rawClaims: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  );
  const claims = nintendoPlayActivityIdTokenClaimsSchema.parse(rawClaims);
  if (!claims.sub) {
    throw new Error("Nintendo Play Activity ID token is missing a subject");
  }
  return {
    accountId: claims.sub,
    username: claims.preferred_username ?? claims.name ?? null,
    email: claims.email ?? null,
  };
}

export function nintendoPlayActivityUserInfo(
  idToken: string,
): ConnectorAuthProviderGrantUserInfo {
  const identity = parseNintendoPlayActivityIdentity(idToken);
  return {
    id: identity.accountId,
    username: identity.username,
    email: identity.email,
  };
}

export function nintendoPlayActivityAccountId(idToken: string): string {
  return parseNintendoPlayActivityIdentity(idToken).accountId;
}
