import type { OAuthConnectorType } from "@vm0/connectors/connectors";
import {
  CONNECTOR_OAUTH_PROVIDERS,
  type AuthUrlResult,
} from "@vm0/connectors/oauth-providers";

import { env } from "../../lib/env";

export const CONNECTOR_OAUTH_STATE_COOKIE_NAME = "connector_oauth_state";
export const CONNECTOR_OAUTH_SESSION_COOKIE_NAME = "connector_oauth_session";
export const CONNECTOR_OAUTH_PKCE_COOKIE_NAME = "connector_oauth_pkce";
export const CONNECTOR_OAUTH_CONTEXT_COOKIE_NAME = "connector_oauth_context";
export const CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS = 15 * 60;
const CONNECTOR_OAUTH_REDIRECT_STATUS = 307;

export function generateConnectorOAuthState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

export function buildOAuthCookieHeader(
  name: string,
  value: string,
  maxAge: number,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (env("ENV") === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function buildDeleteOAuthCookieHeader(name: string): string {
  return `${name}=; Max-Age=0; Path=/`;
}

export function clearOAuthCookies(response: Response): void {
  response.headers.append(
    "Set-Cookie",
    buildDeleteOAuthCookieHeader(CONNECTOR_OAUTH_STATE_COOKIE_NAME),
  );
  response.headers.append(
    "Set-Cookie",
    buildDeleteOAuthCookieHeader(CONNECTOR_OAUTH_SESSION_COOKIE_NAME),
  );
  response.headers.append(
    "Set-Cookie",
    buildDeleteOAuthCookieHeader(CONNECTOR_OAUTH_PKCE_COOKIE_NAME),
  );
  response.headers.append(
    "Set-Cookie",
    buildDeleteOAuthCookieHeader(CONNECTOR_OAUTH_CONTEXT_COOKIE_NAME),
  );
}

export function redirectResponse(url: string): Response {
  return new Response(null, {
    status: CONNECTOR_OAUTH_REDIRECT_STATUS,
    headers: { location: url },
  });
}

function normalizeAuthUrlResult(result: string | AuthUrlResult): AuthUrlResult {
  return typeof result === "string" ? { url: result } : result;
}

export async function buildProviderAuthorizeUrl(args: {
  readonly type: OAuthConnectorType;
  readonly clientId?: string;
  readonly redirectUri: string;
  readonly state: string;
}): Promise<AuthUrlResult> {
  const provider = CONNECTOR_OAUTH_PROVIDERS[args.type];
  return normalizeAuthUrlResult(
    await provider.buildAuthUrl({
      clientId: args.clientId,
      redirectUri: args.redirectUri,
      state: args.state,
    }),
  );
}
