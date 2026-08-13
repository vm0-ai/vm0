import { Buffer } from "node:buffer";

import { z } from "zod";

import type { ConnectorExternalCodeGrantConfig } from "@okouai/connectors/connector-config";
import type { ConnectorAuthProviderGrantUserInfo } from "../../grant-result";
import { OAuthProviderHttpError, throwOAuthError } from "../../oauth/error";

export const PLAYSTATION_AUTH_BASE_URL =
  "https://ca.account.sony.com/api/authz/v3/oauth";
export const PLAYSTATION_NPSSO_URL =
  "https://ca.account.sony.com/api/v1/ssocookie";
export const PLAYSTATION_PROFILE_USERS_URL =
  "https://m.np.playstation.com/api/userProfile/v1/internal/users";
export const PLAYSTATION_REDIRECT_URI =
  "com.scee.psxandroid.scecompcall://redirect";
export const PLAYSTATION_WEB_SESSION_SIGNIN_URL =
  "https://web.np.playstation.com/api/session/v1/signin";
export const PLAYSTATION_WEB_SESSION_CALLBACK_URL =
  "https://web.np.playstation.com/api/session/v1/session";
const PLAYSTATION_CLIENT_SECRET = "ucPjka5tntB2KqsP";
const PLAYSTATION_STORE_REDIRECT_URL = "https://store.playstation.com/";
const PLAYSTATION_WEB_SESSION_COOKIE_NAME = "pdccws_p";
const PLAYSTATION_WEB_SESSION_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140.0.0.0 Safari/537.36";

interface PlaystationAuthToken {
  readonly accessToken: string;
  readonly expiresIn?: number;
  readonly idToken: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresIn?: number;
  readonly scope: string;
  readonly tokenType: string;
}

interface PlaystationProfile {
  readonly accountId?: string;
  readonly onlineId?: string;
}

interface PlaystationIdentity {
  readonly accountId: string;
  readonly onlineId: string | null;
}

const playstationAuthTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  id_token: z.string().min(1),
  refresh_token: z.string().min(1),
  refresh_token_expires_in: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

const playstationRefreshTokenSchema = playstationAuthTokenSchema.extend({
  refresh_token: z.string().min(1).optional(),
});

const playstationProfileSchema = z
  .object({
    accountId: z.string().min(1).optional(),
    onlineId: z.string().min(1).optional(),
  })
  .passthrough();

const playstationIdTokenClaimsSchema = z
  .object({
    sub: z.string().min(1).optional(),
    account_id: z.string().min(1).optional(),
    online_id: z.string().min(1).optional(),
  })
  .passthrough();

const playstationNpssoJsonSchema = z
  .object({
    npsso: z.string().min(1),
  })
  .passthrough();

function invalidNpssoError(): OAuthProviderHttpError {
  return new OAuthProviderHttpError(
    "PlayStation NPSSO exchange failed: invalid NPSSO token",
    400,
    "invalid_grant",
  );
}

export function normalizePlaystationNpsso(input: string): string {
  const trimmed = input.trim();
  let value = trimmed;

  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const npssoJson = playstationNpssoJsonSchema.safeParse(parsed);
      if (!npssoJson.success) {
        throw invalidNpssoError();
      }
      value = npssoJson.data.npsso.trim();
    } catch {
      throw invalidNpssoError();
    }
  }

  if (!value || hasInvalidNpssoCookieCharacter(value)) {
    throw invalidNpssoError();
  }
  return value;
}

function playstationWebSessionError(
  message: string,
  status: number,
): OAuthProviderHttpError {
  return new OAuthProviderHttpError(
    `PlayStation web session exchange failed: ${message}`,
    status,
    "invalid_grant",
  );
}

function validatedRedirectLocation(
  response: Response,
  expected: { readonly hostname: string; readonly pathname: string },
): URL {
  const location = response.headers.get("location");
  if (!location) {
    throw playstationWebSessionError(
      `missing redirect (${response.status})`,
      response.status,
    );
  }

  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw playstationWebSessionError(
      `invalid redirect (${response.status})`,
      response.status,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname !== expected.hostname ||
    url.port !== "" ||
    url.pathname !== expected.pathname
  ) {
    throw playstationWebSessionError(
      `unexpected redirect (${response.status})`,
      response.status,
    );
  }
  return url;
}

function responseSetCookieHeaders(headers: Headers): readonly string[] {
  return headers.getSetCookie();
}

function cookiePairFromSetCookie(setCookie: string): string | null {
  const pair = setCookie.split(";", 1)[0]?.trim();
  if (!pair) {
    return null;
  }
  const equalsIndex = pair.indexOf("=");
  if (equalsIndex <= 0) {
    return null;
  }
  const name = pair.slice(0, equalsIndex);
  const value = pair.slice(equalsIndex + 1);
  if (
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
    !value ||
    hasInvalidNpssoCookieCharacter(value)
  ) {
    return null;
  }
  return `${name}=${value}`;
}

function responseCookiePairs(headers: Headers): readonly string[] {
  return responseSetCookieHeaders(headers).flatMap((setCookie) => {
    const pair = cookiePairFromSetCookie(setCookie);
    return pair === null ? [] : [pair];
  });
}

function cookieValue(
  pairs: readonly string[],
  expectedName: string,
): string | null {
  for (const pair of pairs) {
    const equalsIndex = pair.indexOf("=");
    if (pair.slice(0, equalsIndex) === expectedName) {
      return pair.slice(equalsIndex + 1);
    }
  }
  return null;
}

export async function exchangePlaystationNpssoForWebSessionToken(
  rawNpsso: string,
  signal: AbortSignal,
): Promise<string> {
  const npsso = normalizePlaystationNpsso(rawNpsso);
  const signinUrl = new URL(PLAYSTATION_WEB_SESSION_SIGNIN_URL);
  signinUrl.searchParams.set("redirect_uri", PLAYSTATION_STORE_REDIRECT_URL);
  signinUrl.searchParams.set("smcid", "web:store");

  const signinResponse = await fetch(signinUrl, {
    headers: { "User-Agent": PLAYSTATION_WEB_SESSION_USER_AGENT },
    redirect: "manual",
    signal,
  });
  const authorizeUrl = validatedRedirectLocation(signinResponse, {
    hostname: "ca.account.sony.com",
    pathname: "/api/authz/v3/oauth/authorize",
  });
  const signinCookiePairs = responseCookiePairs(signinResponse.headers);
  const initialWebSessionToken = cookieValue(
    signinCookiePairs,
    PLAYSTATION_WEB_SESSION_COOKIE_NAME,
  );
  if (!initialWebSessionToken) {
    throw playstationWebSessionError(
      `missing ${PLAYSTATION_WEB_SESSION_COOKIE_NAME} cookie`,
      signinResponse.status,
    );
  }

  const authorizeResponse = await fetch(authorizeUrl, {
    headers: {
      Cookie: `npsso=${npsso}`,
      "User-Agent": PLAYSTATION_WEB_SESSION_USER_AGENT,
    },
    redirect: "manual",
    signal,
  });
  const callbackUrl = validatedRedirectLocation(authorizeResponse, {
    hostname: "web.np.playstation.com",
    pathname: "/api/session/v1/session",
  });
  if (!callbackUrl.searchParams.get("code")) {
    throw playstationWebSessionError(
      `missing authorization code (${authorizeResponse.status})`,
      authorizeResponse.status,
    );
  }

  const callbackResponse = await fetch(callbackUrl, {
    headers: {
      Cookie: signinCookiePairs.join("; "),
      "User-Agent": PLAYSTATION_WEB_SESSION_USER_AGENT,
    },
    redirect: "manual",
    signal,
  });
  if (!callbackResponse.ok && callbackResponse.status !== 302) {
    throw playstationWebSessionError(
      `callback failed (${callbackResponse.status})`,
      callbackResponse.status,
    );
  }
  const callbackWebSessionToken = cookieValue(
    responseCookiePairs(callbackResponse.headers),
    PLAYSTATION_WEB_SESSION_COOKIE_NAME,
  );
  return callbackWebSessionToken ?? initialWebSessionToken;
}

function hasInvalidNpssoCookieCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint < 0x21 ||
      codePoint > 0x7e ||
      codePoint === 0x22 ||
      codePoint === 0x2c ||
      codePoint === 0x3b ||
      codePoint === 0x5c
    ) {
      return true;
    }
  }
  return false;
}

function playstationClientBasicAuthHeader(clientId: string): string {
  return `Basic ${Buffer.from(
    `${clientId}:${PLAYSTATION_CLIENT_SECRET}`,
  ).toString("base64")}`;
}

export function buildPlaystationNpssoUrl(): string {
  return PLAYSTATION_NPSSO_URL;
}

function buildPlaystationAuthorizationUrl(args: {
  readonly clientId: string;
  readonly grant: ConnectorExternalCodeGrantConfig;
}): string {
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: args.clientId,
    redirect_uri: PLAYSTATION_REDIRECT_URI,
    response_type: "code",
    scope: args.grant.scopes.join(" "),
  });

  return `${PLAYSTATION_AUTH_BASE_URL}/authorize?${params.toString()}`;
}

function authorizationCodeFromRedirect(location: string | null): string | null {
  if (!location) {
    return null;
  }

  try {
    return new URL(location).searchParams.get("code");
  } catch {
    const query = location.includes("redirect/")
      ? location.split("redirect/")[1]
      : location;
    const params = new URLSearchParams(query);
    return params.get("code");
  }
}

export async function exchangePlaystationNpssoForAccessCode(
  args: {
    readonly npsso: string;
    readonly clientId: string;
    readonly grant: ConnectorExternalCodeGrantConfig;
  },
  signal: AbortSignal,
): Promise<string> {
  const npsso = normalizePlaystationNpsso(args.npsso);
  const response = await fetch(
    buildPlaystationAuthorizationUrl({
      clientId: args.clientId,
      grant: args.grant,
    }),
    {
      headers: {
        Cookie: `npsso=${npsso}`,
      },
      redirect: "manual",
      signal,
    },
  );
  const code = authorizationCodeFromRedirect(response.headers.get("location"));
  if (code) {
    return code;
  }
  throw new OAuthProviderHttpError(
    `PlayStation NPSSO exchange failed: ${response.status}`,
    response.status,
    "invalid_grant",
  );
}

function playstationTokenFromResponse(
  raw: z.infer<typeof playstationAuthTokenSchema>,
): PlaystationAuthToken {
  return {
    accessToken: raw.access_token,
    ...(raw.expires_in === undefined ? {} : { expiresIn: raw.expires_in }),
    idToken: raw.id_token,
    refreshToken: raw.refresh_token,
    ...(raw.refresh_token_expires_in === undefined
      ? {}
      : { refreshTokenExpiresIn: raw.refresh_token_expires_in }),
    scope: raw.scope ?? "",
    tokenType: raw.token_type ?? "bearer",
  };
}

async function tokenResponseJson(
  response: Response,
  operation: "exchange" | "refresh",
): Promise<unknown> {
  if (!response.ok) {
    await throwOAuthError("PlayStation", operation, response);
  }
  return await response.json();
}

export async function exchangePlaystationAccessCodeForAuthTokens(
  args: {
    readonly accessCode: string;
    readonly clientId: string;
  },
  signal: AbortSignal,
): Promise<PlaystationAuthToken> {
  const response = await fetch(`${PLAYSTATION_AUTH_BASE_URL}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: playstationClientBasicAuthHeader(args.clientId),
    },
    body: new URLSearchParams({
      code: args.accessCode,
      redirect_uri: PLAYSTATION_REDIRECT_URI,
      grant_type: "authorization_code",
      token_format: "jwt",
    }),
    signal,
  });

  return playstationTokenFromResponse(
    playstationAuthTokenSchema.parse(
      await tokenResponseJson(response, "exchange"),
    ),
  );
}

export async function refreshPlaystationAuthTokens(
  args: {
    readonly refreshToken: string;
    readonly clientId: string;
  },
  signal: AbortSignal,
): Promise<PlaystationAuthToken> {
  const response = await fetch(`${PLAYSTATION_AUTH_BASE_URL}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: playstationClientBasicAuthHeader(args.clientId),
    },
    body: new URLSearchParams({
      refresh_token: args.refreshToken,
      grant_type: "refresh_token",
      token_format: "jwt",
      scope: "psn:mobile.v2.core psn:clientapp",
    }),
    signal,
  });

  const raw = playstationRefreshTokenSchema.parse(
    await tokenResponseJson(response, "refresh"),
  );
  return playstationTokenFromResponse({
    ...raw,
    refresh_token: raw.refresh_token ?? args.refreshToken,
  });
}

function parsePlaystationIdToken(idToken: string): PlaystationIdentity {
  const [, payload] = idToken.split(".");
  if (!payload) {
    throw new Error("PlayStation ID token is missing a payload");
  }
  const rawClaims: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  );
  const claims = playstationIdTokenClaimsSchema.parse(rawClaims);
  const accountId = claims.account_id ?? claims.sub;
  if (!accountId) {
    throw new Error("PlayStation ID token is missing an account id");
  }
  return {
    accountId,
    onlineId: claims.online_id ?? null,
  };
}

async function fetchPlaystationProfile(
  args: {
    readonly accessToken: string;
    readonly accountId: string;
  },
  signal: AbortSignal,
): Promise<PlaystationProfile> {
  const response = await fetch(
    `${PLAYSTATION_PROFILE_USERS_URL}/${encodeURIComponent(args.accountId)}/profiles`,
    {
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
      },
      signal,
    },
  );
  if (!response.ok) {
    await throwOAuthError("PlayStation", "profile", response);
  }
  return playstationProfileSchema.parse(await response.json());
}

export async function fetchPlaystationIdentity(
  args: {
    readonly accessToken: string;
    readonly idToken: string;
  },
  signal: AbortSignal,
): Promise<PlaystationIdentity> {
  const tokenIdentity = parsePlaystationIdToken(args.idToken);
  const profile = await fetchPlaystationProfile(
    {
      accessToken: args.accessToken,
      accountId: tokenIdentity.accountId,
    },
    signal,
  );
  return {
    accountId: profile.accountId ?? tokenIdentity.accountId,
    onlineId: profile.onlineId ?? tokenIdentity.onlineId,
  };
}

export function playstationUserInfo(
  identity: PlaystationIdentity,
): ConnectorAuthProviderGrantUserInfo {
  return {
    id: identity.accountId,
    username: identity.onlineId,
    email: null,
  };
}
